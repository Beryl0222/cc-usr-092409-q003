/**
 * 演出负荷护照领域模型（零依赖）。
 *
 * 设计要点：
 * - 事件溯源：护照状态全部由事件折叠得到，事件标识/时间/版本不原地改写，更正只追加后继记录。
 * - 负荷三维：light（强光）、tension（牵拉）、transport（运输），按部件材质系数累计。
 * - 一次提交（batch）中的事件要么全部生效、要么全部不生效，用于跨古件/跨剧团的原子占用。
 * - 折叠过程中维护全局资源占用表（本件部件、共享部件、复制替身），跨护照冲突同样被拒绝。
 */

import { createHash } from "node:crypto";

export const LOAD_DIMENSIONS = ["light", "tension", "transport"];

/** 各使用阶段对原件的标准负荷（再乘以部件材质系数）。 */
export const STAGE_LOAD = {
  rehearsal: { light: 1, tension: 1, transport: 0 },
  performance: { light: 2, tension: 2, transport: 0 },
  transit: { light: 0, tension: 0, transport: 1 },
};

export class ModelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ModelError";
    this.code = code;
  }
}

export function round4(value) {
  return Math.round((value + Number.EPSILON) * 1e4) / 1e4;
}

export function parseTime(value, field = "时间") {
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) throw new ModelError("BAD_TIME", `${field}不是合法 ISO 时间：${value}`);
  return t;
}

/** 稳定序列化：键排序，保证同内容哈希一致。 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export function contentHash(eventType, aggregateId, payload) {
  return createHash("sha256")
    .update(stableStringify({ eventType, aggregateId, payload }))
    .digest("hex");
}

function zeroLoad() {
  return { light: 0, tension: 0, transport: 0 };
}

function addLoad(total, extra) {
  for (const dim of LOAD_DIMENSIONS) total[dim] = round4(total[dim] + (extra[dim] ?? 0));
}

function compFactor(components, componentId) {
  const comp = components.get(componentId);
  if (!comp) throw new ModelError("UNKNOWN_COMPONENT", `部件不存在：${componentId}`);
  return comp;
}

/**
 * 计算一条使用决定（一个场次/运输段对各部件的使用方式）对原件造成的负荷。
 * mode 为 substitute（复制替身承担）的部件不消耗原件额度，但仍记录在案以便还原。
 */
export function demandForDecision(components, entries, stage) {
  const base = STAGE_LOAD[stage];
  if (!base) throw new ModelError("UNKNOWN_STAGE", `未知使用阶段：${stage}`);
  const byComponent = {};
  const total = zeroLoad();
  for (const entry of entries) {
    const item = {
      component_id: entry.component_id,
      mode: entry.mode,
      substitute_id: entry.substitute_id ?? null,
      damage: zeroLoad(),
    };
    if (entry.mode === "original" || entry.mode === "repair") {
      const comp = compFactor(components, entry.component_id);
      for (const dim of LOAD_DIMENSIONS) {
        const cost = base[dim] * (comp.factors?.[dim] ?? 1);
        if (cost > 0) item.damage[dim] = round4(cost);
      }
      addLoad(total, item.damage);
    }
    byComponent[entry.component_id] = item;
  }
  return { byComponent, total };
}

function intervalsOverlap(a, b) {
  return parseTime(a.from) < parseTime(b.to) && parseTime(a.to) > parseTime(b.from);
}

function freshPassport(passportId) {
  return {
    passport_id: passportId,
    puppet_id: null,
    puppet_name: null,
    exists: false,
    inspection: null,
    inspections: [],
    components: new Map(),
    performances: new Map(),
    ledger: [],
    repairs: new Map(),
    damage: null,
    observation: new Map(), // component_id -> 观察期截止时间
    awaiting_inspection: false, // 修复已签认，等待新检查结果
    seq: 0,
  };
}

/** 把全部历史事件折叠成内存数据库（跨护照）。 */
export function foldEvents(events) {
  const db = {
    passports: new Map(),
    substitutes: new Map(),
    occupancy: [],
    notices: new Map(),
    reviews: [],
    requestIndex: new Map(), // request_id -> {event_id, hash}
  };
  for (const event of events) applyEvent(db, event);
  return db;
}

export function passportsView(db) {
  const views = new Map();
  for (const [id, state] of db.passports) views.set(id, buildPassportView(db, state));
  return views;
}

function getPassport(db, passportId) {
  let state = db.passports.get(passportId);
  if (!state) {
    state = freshPassport(passportId);
    db.passports.set(passportId, state);
  }
  return state;
}

function requireExists(state) {
  if (!state.exists) throw new ModelError("PASSPORT_NOT_OPEN", `护照尚无有效检查版本：${state.passport_id}`);
}

/** 有效（计入额度）的台账明细：已确认或已完成，且属于当前检查周期。 */
function activeEntries(state) {
  const inspectionId = state.inspection?.inspection_id ?? null;
  return state.ledger.filter(
    (e) => (e.status === "confirmed" || e.status === "completed") && e.inspection_id === inspectionId,
  );
}

export function balances(state) {
  const used = zeroLoad();
  const reserved = zeroLoad();
  for (const entry of activeEntries(state)) {
    addLoad(entry.status === "completed" ? used : reserved, entry.damage.total);
  }
  const quota = state.inspection?.quota ?? zeroLoad();
  const available = {};
  for (const dim of LOAD_DIMENSIONS) {
    available[dim] = round4(quota[dim] - used[dim] - reserved[dim]);
  }
  return { quota: { ...quota }, used, reserved, available };
}

function lifetimeLoad(state) {
  const total = zeroLoad();
  for (const entry of state.ledger) {
    if (entry.status === "confirmed" || entry.status === "completed" || entry.status === "interrupted") {
      addLoad(total, entry.damage.total);
    }
  }
  return total;
}

function resourcesFor(state, run, entries) {
  const resources = [];
  for (const entry of entries) {
    if (entry.mode === "substitute") {
      resources.push({ kind: "substitute", key: `sub:${entry.substitute_id}` });
    } else {
      const comp = compFactor(state.components, entry.component_id);
      resources.push({ kind: "component", key: `comp:${state.passport_id}:${comp.component_id}` });
      if (comp.shared_part_id) resources.push({ kind: "shared_part", key: `shared:${comp.shared_part_id}` });
    }
  }
  return resources.map((r) => ({ ...r, from: run.from, to: run.to }));
}

function assertNoOccupancy(db, state, run, entries, ignoreLedgerId = null) {
  const wanted = resourcesFor(state, run, entries);
  const active = db.occupancy.filter((o) => o.ledger_id !== ignoreLedgerId);
  for (const wish of wanted) {
    for (const held of active) {
      if (wish.key === held.key && intervalsOverlap(wish, held)) {
        throw new ModelError(
          "RESOURCE_BUSY",
          `资源在 ${wish.from}~${wish.to} 已被占用：${wish.key}（占用方 ${held.passport_id}/${held.performance_id}/${held.run_id}）`,
        );
      }
    }
  }
}

function releaseOccupancy(db, ledgerId) {
  db.occupancy = db.occupancy.filter((o) => o.ledger_id !== ledgerId);
}

function ledgerIdFor(state, performanceId, run, inspectionId, confirmationNo) {
  return `led:${state.passport_id}:${performanceId}:${run.run_id}:rev${run.plan_revision}:insp${inspectionId}:c${confirmationNo}`;
}

/** 找到场次当前版本下尚未终结（未取消/未完成）的台账明细。 */
function findOpenLedger(state, performanceId, runId) {
  return state.ledger.find(
    (e) =>
      e.performance_id === performanceId &&
      e.run_id === runId &&
      e.status !== "cancelled" &&
      e.status !== "completed" &&
      e.status !== "superseded",
  );
}

/** 找到某场次（当前版本）最新一条有效台账明细，含已完成/已中断。 */
function findLedgerForRun(state, performanceId, run) {
  let hit = null;
  for (const e of state.ledger) {
    if (e.performance_id === performanceId && e.run_id === run.run_id && e.plan_revision === run.plan_revision) {
      if (e.status !== "superseded" && e.status !== "cancelled") hit = e;
    }
  }
  return hit;
}

function runOf(state, performanceId, runId) {
  const perf = state.performances.get(performanceId);
  if (!perf) throw new ModelError("UNKNOWN_PERFORMANCE", `演出不存在：${performanceId}`);
  const run = perf.runs.get(runId);
  if (!run) throw new ModelError("UNKNOWN_RUN", `场次不存在：${performanceId}/${runId}`);
  return { perf, run };
}

function assertWithinQuota(state, demand) {
  const { available } = balances(state);
  for (const dim of LOAD_DIMENSIONS) {
    if (round4(demand[dim] - available[dim]) > 0) {
      throw new ModelError(
        "QUOTA_EXCEEDED",
        `额度不足（${dim}）：需要 ${demand[dim]}，可用 ${available[dim]}`,
      );
    }
  }
}

function assertObservation(state, run, entries, at) {
  const runStart = parseTime(run.from ?? at);
  for (const entry of entries) {
    if (entry.mode !== "original" && entry.mode !== "repair") continue;
    const until = state.observation.get(entry.component_id);
    if (until && runStart < parseTime(until)) {
      throw new ModelError(
        "UNDER_OBSERVATION",
        `部件 ${entry.component_id} 观察期至 ${until}，${run.from} 不得使用原件，应改用替身或局部替换`,
      );
    }
  }
}

function assertSubstituteKnown(db, entries) {
  for (const entry of entries) {
    if (entry.mode !== "substitute") continue;
    const sub = db.substitutes.get(entry.substitute_id);
    if (!sub) throw new ModelError("UNKNOWN_SUBSTITUTE", `复制替身未登记：${entry.substitute_id}`);
    if (sub.component_id !== entry.component_id) {
      throw new ModelError(
        "SUBSTITUTE_MISMATCH",
        `替身 ${entry.substitute_id} 对应部件 ${sub.component_id}，不能替换 ${entry.component_id}`,
      );
    }
  }
}

function applyConfirm(db, state, p) {
  requireExists(state);
  const usesOriginal = p.entries.some((e) => e.mode === "original" || e.mode === "repair");
  if (state.awaiting_inspection && usesOriginal) {
    throw new ModelError(
      "AWAITING_INSPECTION",
      `修复已签认，须先登记新检查结果恢复额度，此前只能使用复制替身`,
    );
  }
  const { perf, run } = runOf(state, p.performance_id, p.run_id);
  if (perf.paused && !perf.standby) throw new ModelError("PERFORMANCE_PAUSED", `演出已暂停：${p.performance_id}`);
  if (run.plan_revision !== p.plan_revision) {
    throw new ModelError("PLAN_REVISED", `场次计划已改期，请按新版本重新确认：${p.run_id}`);
  }
  if (run.status !== "planned") {
    throw new ModelError("RUN_NOT_OPEN", `场次当前状态 ${run.status}，不能确认：${p.run_id}`);
  }
  assertSubstituteKnown(db, p.entries);
  assertObservation(state, run, p.entries, p.at);

  // 局部替换时，受损未修复部件不得以原件方式使用。
  if (state.damage) {
    for (const entry of p.entries) {
      if ((entry.mode === "original" || entry.mode === "repair") && state.damage.components.includes(entry.component_id)) {
        throw new ModelError("DAMAGED_COMPONENT", `部件 ${entry.component_id} 已受损，本场只能以替身替换`);
      }
    }
  }

  const demand = demandForDecision(state.components, p.entries, run.kind === "transit" ? "transit" : run.stage);
  assertNoOccupancy(db, state, run, p.entries);
  assertWithinQuota(state, demand.total);

  const inspectionId = state.inspection.inspection_id;
  const confirmationNo =
    state.ledger.filter(
      (e) => e.performance_id === p.performance_id && e.run_id === p.run_id && e.plan_revision === run.plan_revision,
    ).length + 1;
  const ledgerId = ledgerIdFor(state, p.performance_id, run, inspectionId, confirmationNo);
  const ledgerEntry = {
    ledger_id: ledgerId,
    performance_id: p.performance_id,
    run_id: p.run_id,
    plan_revision: p.plan_revision,
    kind: run.kind,
    stage: run.stage ?? null,
    from: run.from,
    to: run.to,
    entries: p.entries,
    demand,
    damage: demand, // 确认时按计划锁定的消耗（完成回执不改变依据，保持当时计算）
    inspection_id: state.inspection.inspection_id,
    approver: p.approver,
    note: p.note ?? null,
    confirmed_event_id: p.event_id,
    confirmed_at: p.at,
    status: "confirmed",
    completed_at: null,
    receipt_request_id: null,
  };
  state.ledger.push(ledgerEntry);
  for (const wish of resourcesFor(state, run, p.entries)) {
    db.occupancy.push({
      ...wish,
      ledger_id: ledgerId,
      passport_id: state.passport_id,
      performance_id: p.performance_id,
      run_id: p.run_id,
    });
  }
  run.status = "confirmed";
  run.confirmation = {
    ledger_id: ledgerId,
    approver: p.approver,
    entries: p.entries,
    inspection_id: state.inspection.inspection_id,
    event_id: p.event_id,
    at: p.at,
  };
}

function applyCancel(db, state, p) {
  const { run } = runOf(state, p.performance_id, p.run_id);
  if (run.status !== "confirmed" && run.status !== "paused") {
    throw new ModelError("RUN_NOT_OPEN", `场次当前状态 ${run.status}，无需取消：${p.run_id}`);
  }
  const entry = findOpenLedger(state, p.performance_id, p.run_id);
  if (entry) {
    entry.status = "superseded";
    entry.cancel_reason = p.reason;
    entry.cancel_event_id = p.event_id;
    releaseOccupancy(db, entry.ledger_id);
  }
  run.status = "planned";
}

function applyEvent(db, event) {
  const p = event.payload ?? {};
  switch (event.event_type) {
    /* ---------------- 复制替身（全局登记） ---------------- */
    case "SUBSTITUTE_REGISTERED": {
      if (db.substitutes.has(p.substitute_id)) {
        throw new ModelError("DUP_SUBSTITUTE", `替身已存在：${p.substitute_id}`);
      }
      db.substitutes.set(p.substitute_id, { ...p, registered_at: p.at });
      return;
    }

    /* ---------------- 古件检查：建立护照或修复后换版 ---------------- */
    case "OBJECT_INSPECTED": {
      const state = getPassport(db, p.passport_id);
      state.seq += 1;
      if (!state.exists) {
        if (p.predecessor_inspection_id) {
          throw new ModelError("BAD_PREDECESSOR", "首次检查不能携带前驱检查版本");
        }
        state.exists = true;
        state.puppet_id = p.puppet_id;
        state.puppet_name = p.puppet_name ?? null;
      } else {
        if (p.predecessor_inspection_id !== state.inspection.inspection_id) {
          throw new ModelError(
            "BAD_PREDECESSOR",
            `前驱检查版本不匹配：应为 ${state.inspection.inspection_id}，收到 ${p.predecessor_inspection_id}`,
          );
        }
        if (!state.awaiting_inspection) {
          throw new ModelError(
            "RESTORATION_REQUIRED",
            "已有检查版本只能在双人签认修复后凭新检查结果换版，不得直接重设额度",
          );
        }
        state.awaiting_inspection = false;
      }
      const components = new Map();
      for (const c of p.components) {
        components.set(c.component_id, {
          component_id: c.component_id,
          name: c.name ?? c.component_id,
          material: c.material ?? null,
          shared_part_id: c.shared_part_id ?? null,
          factors: { light: c.factors?.light ?? 1, tension: c.factors?.tension ?? 1, transport: c.factors?.transport ?? 1 },
        });
      }
      const inspection = {
        inspection_id: p.inspection_id,
        inspected_at: p.inspected_at,
        issued_at: p.at,
        predecessor_inspection_id: p.predecessor_inspection_id ?? null,
        quota: { light: p.quota.light, tension: p.quota.tension, transport: p.quota.transport },
        components: [...components.values()],
        note: p.note ?? null,
        event_id: event.event_id,
      };
      state.inspection = inspection;
      state.inspections.push(inspection);
      state.components = components;
      return;
    }

    /* ---------------- 演出排期 ---------------- */
    case "PERFORMANCE_PLANNED": {
      const state = getPassport(db, p.passport_id);
      requireExists(state);
      state.seq += 1;
      if (state.performances.has(p.performance_id)) {
        throw new ModelError("DUP_PERFORMANCE", `演出已存在：${p.performance_id}`);
      }
      state.performances.set(p.performance_id, {
        performance_id: p.performance_id,
        troupe_id: p.troupe_id,
        title: p.title ?? null,
        created_at: p.at,
        paused: false,
        pause_reason: null,
        plan_revision: 1,
        runs: new Map(
          p.runs.map((r) => [
            r.run_id,
            { run_id: r.run_id, plan_revision: 1, kind: r.kind, stage: r.stage ?? null, from: r.from, to: r.to, status: "planned" },
          ]),
        ),
        timeline: [{ type: "planned", at: p.at, event_id: event.event_id }],
      });
      return;
    }

    case "PERFORMANCE_RESCHEDULED": {
      const state = getPassport(db, p.passport_id);
      requireExists(state);
      state.seq += 1;
      const perf = state.performances.get(p.performance_id);
      if (!perf) throw new ModelError("UNKNOWN_PERFORMANCE", `演出不存在：${p.performance_id}`);
      const nextRevision = perf.plan_revision + 1;
      if (p.plan_revision !== nextRevision) {
        throw new ModelError("BAD_REVISION", `改期版本应为 ${nextRevision}，收到 ${p.plan_revision}`);
      }
      // 旧版本未完成场次作废（其确认/占用应由同批次的 STAGE_USE_CANCELLED 先释放）。
      for (const run of perf.runs.values()) {
        if (run.plan_revision !== perf.plan_revision) continue;
        if (run.status === "completed") continue;
        if (run.status === "confirmed") {
          throw new ModelError("CANCEL_FIRST", `改期前必须先取消已确认场次：${run.run_id}`);
        }
        if (run.status === "planned" || run.status === "paused" || run.status === "interrupted") {
          run.status = "superseded";
        }
      }
      for (const r of p.runs) {
        perf.runs.set(r.run_id, {
          run_id: r.run_id,
          plan_revision: nextRevision,
          kind: r.kind,
          stage: r.stage ?? null,
          from: r.from,
          to: r.to,
          status: "planned",
        });
      }
      perf.plan_revision = nextRevision;
      perf.timeline.push({ type: "rescheduled", revision: nextRevision, at: p.at, event_id: event.event_id });
      return;
    }

    /* ---------------- 使用确认（原件 / 替身 / 局部替换） ---------------- */
    case "STAGE_USE_CONFIRMED": {
      const state = getPassport(db, p.passport_id);
      state.seq += 1;
      applyConfirm(db, state, { ...p, event_id: event.event_id });
      const perf = state.performances.get(p.performance_id);
      perf.timeline.push({ type: "use_confirmed", run_id: p.run_id, at: p.at, event_id: event.event_id });
      return;
    }

    case "STAGE_USE_CANCELLED": {
      const state = getPassport(db, p.passport_id);
      state.seq += 1;
      applyCancel(db, state, { ...p, event_id: event.event_id });
      return;
    }

    /* ---------------- 现场异常：只暂停相关古件与后续场次 ---------------- */
    case "DAMAGE_REPORTED": {
      const state = getPassport(db, p.passport_id);
      requireExists(state);
      state.seq += 1;
      if (state.damage) throw new ModelError("DAMAGE_OPEN", "已有未闭环的损伤报告");
      const { perf, run } = runOf(state, p.performance_id, p.run_id);
      const current = findOpenLedger(state, p.performance_id, p.run_id);
      if (current && current.status === "confirmed") {
        current.status = "interrupted";
        current.interrupt_event_id = event.event_id;
        releaseOccupancy(db, current.ledger_id);
      } else if (!current) {
        const maybeCompleted = state.ledger.find(
          (e) => e.performance_id === p.performance_id && e.run_id === p.run_id && e.status === "completed",
        );
        if (maybeCompleted) {
          throw new ModelError("RUN_COMPLETED", "已完成的演出保持当时依据，不能回填损伤中断");
        }
      }
      run.status = "interrupted";
      perf.paused = true;
      perf.damage_paused = true;
      perf.timeline.push({ type: "interrupted", run_id: p.run_id, at: p.at, event_id: event.event_id });
      // 暂停该古件在所有剧团所有演出中的后续场次；已完成场次保持当时依据。
      const pauseFrom = parseTime(p.at);
      for (const [otherPid, otherPerf] of state.performances) {
        for (const otherRun of otherPerf.runs.values()) {
          if (otherRun.status !== "confirmed") continue;
          if (parseTime(otherRun.to) <= pauseFrom) continue;
          const future = findOpenLedger(state, otherPid, otherRun.run_id);
          const touchesOriginal =
            future &&
            future.status === "confirmed" &&
            future.entries.some((en) => en.mode === "original" || en.mode === "repair");
          if (touchesOriginal) {
            future.status = "paused";
            future.pause_event_id = event.event_id;
            releaseOccupancy(db, future.ledger_id);
            otherRun.status = "paused";
            otherRun.paused_by_damage = true;
            otherPerf.paused = true;
            otherPerf.damage_paused = true;
            otherPerf.timeline.push({ type: "paused_by_damage", run_id: otherRun.run_id, at: p.at, event_id: event.event_id });
          }
        }
      }
      state.damage = {
        damage_report_id: p.damage_report_id,
        performance_id: p.performance_id,
        run_id: p.run_id,
        components: p.components,
        note: p.note ?? null,
        at: p.at,
        event_id: event.event_id,
        restored_by_repair: null,
      };
      return;
    }

    case "PERFORMANCE_PAUSED": {
      const state = getPassport(db, p.passport_id);
      state.seq += 1;
      const perf = state.performances.get(p.performance_id);
      if (!perf) throw new ModelError("UNKNOWN_PERFORMANCE", `演出不存在：${p.performance_id}`);
      perf.paused = true;
      perf.pause_reason = p.reason;
      perf.paused_at = p.at;
      perf.timeline.push({ type: "paused", reason: p.reason, at: p.at, event_id: event.event_id });
      // 释放后续已确认场次的原件占用，额度让给候补替换方案；台账保留 paused 痕迹。
      for (const run of perf.runs.values()) {
        if (run.status !== "confirmed") continue;
        const entry = findOpenLedger(state, p.performance_id, run.run_id);
        if (entry && entry.status === "confirmed") {
          entry.status = "paused";
          entry.pause_event_id = event.event_id;
          releaseOccupancy(db, entry.ledger_id);
          run.status = "paused";
        }
      }
      return;
    }

    case "PERFORMANCE_RESUMED": {
      const state = getPassport(db, p.passport_id);
      state.seq += 1;
      const perf = state.performances.get(p.performance_id);
      if (!perf || !perf.paused) throw new ModelError("NOT_PAUSED", `演出未处于暂停状态：${p.performance_id}`);
      if (state.damage) throw new ModelError("PASSPORT_PAUSED", "古件尚未完成修复复检，演出不能恢复原件使用");
      perf.paused = false;
      perf.damage_paused = false;
      perf.pause_reason = null;
      perf.timeline.push({ type: "resumed", at: p.at, event_id: event.event_id });
      for (const run of perf.runs.values()) {
        if (run.status === "paused") run.status = "planned";
      }
      return;
    }

    case "STANDBY_ACTIVATED": {
      const state = getPassport(db, p.passport_id);
      state.seq += 1;
      const perf = state.performances.get(p.performance_id);
      if (!perf) throw new ModelError("UNKNOWN_PERFORMANCE", `演出不存在：${p.performance_id}`);
      if (!perf.paused && !state.damage) {
        throw new ModelError("STANDBY_WITHOUT_PAUSE", "只有暂停中的演出（或古件损伤暂停期间）才能启用候补替换");
      }
      perf.standby = {
        basis: p.basis, // full_substitute | local_replacement
        approver: p.approver,
        note: p.note ?? null,
        at: p.at,
        event_id: event.event_id,
      };
      perf.timeline.push({ type: "standby_activated", basis: p.basis, at: p.at, event_id: event.event_id });
      // 候补方案接管：暂停场次回到待确认状态，由保护员按替身/局部替换重新确认；
      // 原件闸口（state.damage / awaiting_inspection / 观察期）仍然有效。
      for (const run of perf.runs.values()) {
        if (run.status === "paused") {
          run.status = "planned";
          run.paused_by_damage = false;
          const old = findOpenLedger(state, p.performance_id, run.run_id);
          if (old && old.status === "paused") {
            old.status = "superseded";
            old.superseded_event_id = event.event_id;
            releaseOccupancy(db, old.ledger_id);
          }
        }
      }
      return;
    }

    /* ---------------- 完成回执（离线幂等在服务层处理） ---------------- */
    case "STAGE_COMPLETED": {
      const state = getPassport(db, p.passport_id);
      state.seq += 1;
      const { run } = runOf(state, p.performance_id, p.run_id);
      if (run.plan_revision !== p.plan_revision) {
        throw new ModelError("PLAN_REVISED", `回执基于旧计划版本，请核对：${p.run_id}`);
      }
      const entry = findLedgerForRun(state, p.performance_id, run);
      if (!entry) throw new ModelError("NOT_CONFIRMED", `场次未经确认，不能回执完成：${p.run_id}`);
      if (entry.status === "completed") {
        throw new ModelError("ALREADY_COMPLETED", `场次已完成：${p.run_id}`);
      }
      if (entry.status === "interrupted") {
        throw new ModelError("RUN_INTERRUPTED", `场次已因异常中断，不能登记完成：${p.run_id}`);
      }
      if (entry.status === "paused") {
        throw new ModelError("RUN_PAUSED", `场次处于暂停，不能登记完成：${p.run_id}`);
      }
      entry.status = "completed";
      entry.completed_at = p.at;
      entry.receipt_request_id = p.receipt_id;
      entry.completed_event_id = event.event_id;
      releaseOccupancy(db, entry.ledger_id);
      run.status = "completed";
      const perf = state.performances.get(p.performance_id);
      perf.timeline.push({ type: "completed", run_id: p.run_id, at: p.at, receipt_id: p.receipt_id, event_id: event.event_id });
      return;
    }

    /* ---------------- 修复与双人签认 ---------------- */
    case "REPAIR_PLANNED": {
      const state = getPassport(db, p.passport_id);
      state.seq += 1;
      if (state.repairs.has(p.repair_id)) throw new ModelError("DUP_REPAIR", `修复方案已存在：${p.repair_id}`);
      if (!state.damage || state.damage.damage_report_id !== p.damage_report_id) {
        throw new ModelError("NO_DAMAGE", "修复方案必须针对一份有效的现场损伤报告");
      }
      state.repairs.set(p.repair_id, {
        repair_id: p.repair_id,
        damage_report_id: p.damage_report_id,
        components: p.components,
        plan: p.plan,
        at: p.at,
        signers: [{ signer: p.signer, at: p.at, event_id: event.event_id }],
        status: "proposed",
        restoration_event_id: null,
      });
      return;
    }

    case "REPAIR_SIGN_RECORDED": {
      const state = getPassport(db, p.passport_id);
      state.seq += 1;
      const repair = state.repairs.get(p.repair_id);
      if (!repair) throw new ModelError("UNKNOWN_REPAIR", `修复方案不存在：${p.repair_id}`);
      if (repair.signers.some((s) => s.signer === p.signer)) {
        throw new ModelError("SIGNER_DUPLICATE", `签认人不能重复：${p.signer}`);
      }
      if (repair.status !== "proposed") {
        throw new ModelError("REPAIR_CLOSED", `修复方案已${repair.status}：${p.repair_id}`);
      }
      repair.signers.push({ signer: p.signer, at: p.at, event_id: event.event_id });
      if (repair.signers.length >= 2) repair.status = "signed";
      return;
    }

    case "RESTORATION_APPROVED": {
      const state = getPassport(db, p.passport_id);
      state.seq += 1;
      const repair = state.repairs.get(p.repair_id);
      if (!repair) throw new ModelError("UNKNOWN_REPAIR", `修复方案不存在：${p.repair_id}`);
      if (repair.signers.length < 2) throw new ModelError("NEED_TWO_SIGNERS", "修复方案须经两名保护员签认");
      if (repair.status !== "signed") throw new ModelError("REPAIR_CLOSED", `修复方案状态：${repair.status}`);
      repair.status = "restoration_approved";
      repair.restoration_event_id = event.event_id;
      repair.restored_at = p.at;
      // 解除古件暂停，进入观察期；历史损伤与修复记录保留。
      if (state.damage && state.damage.damage_report_id === repair.damage_report_id) {
        state.damage.restored_by_repair = p.repair_id;
      }
      state.damage = null;
      state.awaiting_inspection = true;
      // 各剧团因本次损伤而暂停的后续场次回到待确认状态，须凭复检版本重新确认。
      for (const perf of state.performances.values()) {
        for (const run of perf.runs.values()) {
          if (run.paused_by_damage) {
            run.status = "planned";
            run.paused_by_damage = false;
            const old = findOpenLedger(state, perf.performance_id, run.run_id);
            if (old && old.status === "paused") {
              old.status = "superseded";
              old.superseded_event_id = event.event_id;
            }
          }
        }
      }
      for (const obs of p.observations ?? []) {
        const prev = state.observation.get(obs.component_id);
        if (!prev || parseTime(obs.until) > parseTime(prev)) state.observation.set(obs.component_id, obs.until);
      }
      return;
    }

    /* ---------------- 通知 outbox（重启后续投） ---------------- */
    case "NOTIFICATION_QUEUED": {
      if (db.notices.has(p.notice_id)) throw new ModelError("DUP_NOTICE", `通知已存在：${p.notice_id}`);
      db.notices.set(p.notice_id, {
        notice_id: p.notice_id,
        passport_id: p.passport_id,
        performance_id: p.performance_id,
        troupe_id: p.troupe_id,
        kind: p.kind,
        message: p.message,
        at: p.at,
        status: "queued",
        attempts: [],
        delivered_at: null,
      });
      return;
    }

    case "NOTIFICATION_DELIVERED": {
      const notice = db.notices.get(p.notice_id);
      if (!notice) throw new ModelError("UNKNOWN_NOTICE", `通知不存在：${p.notice_id}`);
      notice.status = "delivered";
      notice.delivered_at = p.at;
      notice.result = p.result ?? null;
      notice.attempts.push({ at: p.at, result: p.result ?? null });
      return;
    }

    case "NOTIFICATION_DELIVERY_FAILED": {
      const notice = db.notices.get(p.notice_id);
      if (!notice) throw new ModelError("UNKNOWN_NOTICE", `通知不存在：${p.notice_id}`);
      notice.attempts.push({ at: p.at, error: p.error });
      return;
    }

    /* ---------------- 幂等请求索引（与效果事件同批落盘，重启后继续生效） ---------------- */
    case "REQUEST_RECORDED": {
      if (db.requestIndex.has(p.request_id)) {
        throw new ModelError("REQUEST_SEEN", `请求编号已登记：${p.request_id}（重复效果事件必须由服务层幂等拦截）`);
      }
      db.requestIndex.set(p.request_id, {
        request_id: p.request_id,
        kind: p.kind,
        hash: p.hash,
        effect_event_id: p.effect_event_id,
        at: p.at,
      });
      return;
    }

    /* ---------------- 保全复核（同编号重传但内容变化） ---------------- */
    case "REVIEW_FLAGGED": {
      db.reviews.push({ ...p, event_id: event.event_id });
      return;
    }

    default:
      throw new ModelError("UNKNOWN_EVENT", `未知事件类型：${event.event_type}`);
  }
}

/** 在暂存副本上试算整批事件；任一失败则整批拒绝（原子提交）。 */
export function simulateBatch(db, events) {
  const draft = cloneDb(db);
  for (const event of events) applyEvent(draft, event);
  return draft;
}

export function cloneDb(db) {
  const copy = {
    passports: new Map(),
    substitutes: new Map(db.substitutes),
    occupancy: db.occupancy.map((o) => ({ ...o })),
    notices: new Map(),
    reviews: db.reviews.map((r) => ({ ...r })),
    requestIndex: new Map(db.requestIndex),
  };
  for (const [id, state] of db.passports) copy.passports.set(id, cloneState(state));
  for (const [nid, n] of db.notices) copy.notices.set(nid, { ...n, attempts: n.attempts.map((a) => ({ ...a })) });
  return copy;
}

function cloneState(state) {
  return structuredClone({
    ...state,
    components: new Map(state.components),
    performances: new Map([...state.performances].map(([pid, perf]) => [pid, { ...perf, runs: new Map(perf.runs) }])),
    repairs: new Map(state.repairs),
  });
}

/** 排期试算：不写事件，返回每个场次的需求、风险与建议使用方式。 */
export function estimateRun(db, state, run) {
  const allEntries = [...state.components.keys()].map((component_id) => ({ component_id, mode: "original" }));
  const stage = run.kind === "transit" ? "transit" : run.stage;
  const demand = demandForDecision(state.components, allEntries, stage);
  const issues = [];
  const replaceComponents = new Set();

  if (state.damage) {
    for (const cid of state.damage.components) {
      issues.push({ code: "DAMAGED_COMPONENT", component_id: cid, message: `部件 ${cid} 已受损` });
      replaceComponents.add(cid);
    }
  }
  for (const [cid, until] of state.observation) {
    if (parseTime(run.from) < parseTime(until)) {
      issues.push({ code: "UNDER_OBSERVATION", component_id: cid, until, message: `部件 ${cid} 观察期至 ${until}` });
      replaceComponents.add(cid);
    }
  }
  try {
    assertNoOccupancy(db, state, run, allEntries);
  } catch (err) {
    if (err.code === "RESOURCE_BUSY") issues.push({ code: "RESOURCE_BUSY", message: err.message });
  }
  const { available, used, reserved } = balances(state);
  for (const dim of LOAD_DIMENSIONS) {
    if (round4(demand.total[dim] - available[dim]) > 0) {
      issues.push({
        code: "QUOTA_EXCEEDED",
        dim,
        demand: demand.total[dim],
        available: available[dim],
        message: `${dim} 额度不足：需要 ${demand.total[dim]}，可用 ${available[dim]}（已用 ${used[dim]}、已预留 ${reserved[dim]}）`,
      });
    }
  }

  let recommendation = "original";
  if (issues.some((i) => i.code === "RESOURCE_BUSY")) recommendation = "full_substitute";
  else if (replaceComponents.size > 0 || issues.some((i) => i.code === "QUOTA_EXCEEDED")) recommendation = "local_replacement";
  if (issues.length && recommendation === "local_replacement" && replaceComponents.size === state.components.size) {
    recommendation = "full_substitute";
  }

  return {
    run_id: run.run_id,
    kind: run.kind,
    stage,
    from: run.from,
    to: run.to,
    demand,
    balances: balances(state),
    issues,
    recommendation,
    replace_components: [...replaceComponents],
  };
}

export function buildPassportView(db, state) {
  const b = balances(state);
  return {
    passport_id: state.passport_id,
    puppet_id: state.puppet_id,
    puppet_name: state.puppet_name,
    exists: state.exists,
    inspection: state.inspection
      ? {
          inspection_id: state.inspection.inspection_id,
          inspected_at: state.inspection.inspected_at,
          predecessor_inspection_id: state.inspection.predecessor_inspection_id,
          quota: state.inspection.quota,
          note: state.inspection.note,
        }
      : null,
    inspection_versions: state.inspections.map((i) => ({
      inspection_id: i.inspection_id,
      inspected_at: i.inspected_at,
      predecessor_inspection_id: i.predecessor_inspection_id,
      quota: i.quota,
      event_id: i.event_id,
    })),
    components: [...state.components.values()],
    balances: b,
    lifetime_load: lifetimeLoad(state),
    paused: state.damage !== null,
    damage: state.damage,
    observation: [...state.observation.entries()].map(([component_id, until]) => ({ component_id, until })),
    awaiting_inspection: state.awaiting_inspection,
    performances: [...state.performances.values()].map(serializePerformance),
    repairs: [...state.repairs.values()],
    seq: state.seq,
  };
}

function serializePerformance(perf) {
  return {
    performance_id: perf.performance_id,
    troupe_id: perf.troupe_id,
    title: perf.title,
    paused: perf.paused,
    pause_reason: perf.pause_reason,
    plan_revision: perf.plan_revision,
    standby: perf.standby,
    runs: [...perf.runs.values()],
    timeline: perf.timeline,
  };
}

/** 从一次演出还原：实际使用的原件/替身、累计负荷、检查证据、批准人。 */
export function buildPerformanceTrace(db, passportId, performanceId) {
  const state = db.passports.get(passportId);
  if (!state) throw new ModelError("PASSPORT_NOT_OPEN", passportId);
  const perf = state.performances.get(performanceId);
  if (!perf) throw new ModelError("UNKNOWN_PERFORMANCE", performanceId);

  const runs = [...perf.runs.values()].map((run) => {
    const entry = findLedgerForRun(state, performanceId, run);
    const usedItems = entry
      ? entry.entries.map((en) => {
          const comp = state.components.get(en.component_id);
          const item = {
            component_id: en.component_id,
            component_name: comp?.name ?? en.component_id,
            actual: en.mode === "substitute" ? `复制替身 ${en.substitute_id}` : en.mode === "repair" ? "修复后原件" : "原件",
            mode: en.mode,
            substitute_id: en.substitute_id ?? null,
            damage: entry.damage.byComponent[en.component_id]?.damage ?? zeroLoad(),
          };
          return item;
        })
      : [];
    return {
      run_id: run.run_id,
      plan_revision: run.plan_revision,
      kind: run.kind,
      stage: run.stage,
      from: run.from,
      to: run.to,
      status: run.status,
      confirmation: run.confirmation ?? null,
      actual_use: usedItems,
      load_recorded: entry ? entry.damage.total : zeroLoad(),
      inspection_evidence: entry
        ? {
            inspection_id: entry.inspection_id,
            inspected_at: state.inspections.find((i) => i.inspection_id === entry.inspection_id)?.inspected_at ?? null,
            inspection_event_id: state.inspections.find((i) => i.inspection_id === entry.inspection_id)?.event_id ?? null,
          }
        : null,
      approver: entry?.approver ?? null,
      confirmed_event_id: entry?.confirmed_event_id ?? null,
      completed_event_id: entry?.completed_event_id ?? null,
      receipt_id: entry?.receipt_request_id ?? null,
      completed_at: entry?.completed_at ?? null,
    };
  });

  const totals = zeroLoad();
  const byComponent = {};
  for (const run of runs) {
    addLoad(totals, run.load_recorded);
    for (const item of run.actual_use) {
      const slot = (byComponent[item.component_id] ??= { ...zeroLoad() });
      addLoad(slot, item.damage);
    }
  }

  return {
    passport_id: passportId,
    performance_id: performanceId,
    troupe_id: perf.troupe_id,
    title: perf.title,
    paused: perf.paused,
    plan_revision: perf.plan_revision,
    standby: perf.standby ?? null,
    timeline: perf.timeline,
    runs,
    accumulated_load: { total: totals, by_component: byComponent },
  };
}
