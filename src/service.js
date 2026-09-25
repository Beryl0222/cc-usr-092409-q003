/**
 * 保护员应用服务：把业务命令翻译成原子提交的事件批次。
 *
 * 关键约定：
 * - 每个命令生成一个批次，整批通过模型折叠才落盘（跨古件/共享部件的原子占用）。
 * - 离线回执携带客户端 request_id：同编号同内容直接幂等返回；同编号内容变化进入保全复核，不产生业务效果。
 * - 通知是 outbox 事件，与触发原因同批落盘；重启后继续投递未完成通知。
 */
import { randomUUID } from "node:crypto";

import {
  LOAD_DIMENSIONS,
  ModelError,
  balances,
  buildPassportView,
  buildPerformanceTrace,
  contentHash,
  estimateRun,
  parseTime,
  passportsView,
} from "./model.js";

const AGGREGATE_TYPE = {
  OBJECT_INSPECTED: "puppet_object",
  PERFORMANCE_PLANNED: "performance_plan",
  PERFORMANCE_RESCHEDULED: "performance_plan",
  PERFORMANCE_PAUSED: "performance_plan",
  PERFORMANCE_RESUMED: "performance_plan",
  STAGE_USE_CONFIRMED: "performance_plan",
  STAGE_USE_CANCELLED: "performance_plan",
  STAGE_COMPLETED: "performance_plan",
  STANDBY_ACTIVATED: "performance_plan",
  SUBSTITUTE_REGISTERED: "substitute",
  DAMAGE_REPORTED: "conservation_action",
  REPAIR_PLANNED: "conservation_action",
  REPAIR_SIGN_RECORDED: "conservation_action",
  RESTORATION_APPROVED: "conservation_action",
  NOTIFICATION_QUEUED: "notice_outbox",
  NOTIFICATION_DELIVERED: "notice_outbox",
  NOTIFICATION_DELIVERY_FAILED: "notice_outbox",
  REVIEW_FLAGGED: "reconciliation",
  REQUEST_RECORDED: "reconciliation",
};

const SUMMARIES = {
  OBJECT_INSPECTED: "古件检查并发放/换发负荷护照版本",
  PERFORMANCE_PLANNED: "登记演出排期",
  PERFORMANCE_RESCHEDULED: "跨团改期：排期换版",
  PERFORMANCE_PAUSED: "现场原因暂停演出",
  PERFORMANCE_RESUMED: "演出恢复",
  STAGE_USE_CONFIRMED: "保护员确认场次使用方式（原件/替身/局部替换）",
  STAGE_USE_CANCELLED: "取消场次使用确认",
  STAGE_COMPLETED: "现场回执场次完成",
  STANDBY_ACTIVATED: "启用候补替换方案",
  SUBSTITUTE_REGISTERED: "登记复制替身",
  DAMAGE_REPORTED: "现场异常（局部损伤）报告",
  REPAIR_PLANNED: "登记修复方案（首签）",
  REPAIR_SIGN_RECORDED: "修复方案双人签认完成",
  RESTORATION_APPROVED: "修复签认通过，进入复检与观察期",
  NOTIFICATION_QUEUED: "通知入队",
  NOTIFICATION_DELIVERED: "通知投递完成",
  NOTIFICATION_DELIVERY_FAILED: "通知投递失败待重试",
  REVIEW_FLAGGED: "同编号重传内容变化，进入保全复核",
  REQUEST_RECORDED: "幂等请求索引",
};

export { AGGREGATE_TYPE };

export class CareService {
  constructor(store, { now = () => new Date().toISOString() } = {}) {
    this.store = store;
    this.now = now;
    this.aggregateVersions = new Map();
  }

  async start() {
    await this.store.load();
    for (const event of this.store.allEvents()) {
      const v = this.aggregateVersions.get(event.aggregate_id) ?? 0;
      this.aggregateVersions.set(event.aggregate_id, Math.max(v, event.version));
    }
    return this;
  }

  #db() {
    return this.store.state();
  }

  #envelope(type, aggregateId, payload, at, summary) {
    const version = (this.aggregateVersions.get(aggregateId) ?? 0) + 1;
    const event = {
      event_id: `evt_${randomUUID()}`,
      event_type: type,
      aggregate_type: AGGREGATE_TYPE[type],
      aggregate_id: aggregateId,
      occurred_at: at,
      version,
      summary: summary ?? SUMMARIES[type],
      payload: { ...payload, at },
    };
    this.aggregateVersions.set(aggregateId, version);
    return event;
  }

  async #commit(events, { batchId, expectedSeq, passportId } = {}) {
    try {
      return await this.store.append(events, { batchId, expectedSeq, passportId });
    } catch (err) {
      // 提交失败时回滚本批预占的聚合版本号。
      for (const event of events) {
        this.aggregateVersions.set(event.aggregate_id, event.version - 1);
      }
      throw err;
    }
  }

  /* ---------------------------- 幂等键处理 ---------------------------- */

  #requestHash(kind, requestId, payload) {
    // 只对业务体求哈希；服务端补的落库时间不参与（由调用方传入的业务时间仍保留在 payload 中）。
    return contentHash(kind, requestId, payload);
  }

  /**
   * 对携带 request_id 的离线命令做幂等：
   * - 同编号 + 同内容：直接返回既有结果，不追加事件、不重复扣减；
   * - 同编号 + 不同内容：只追加 REVIEW_FLAGGED（同一 request_id+hash 只记一次），命令不生效。
   * 返回 {status: 'duplicate' | 'review' | 'new'}。
   */
  async #dedupRequest(kind, requestId, hash) {
    if (!requestId) return { status: "new" };
    const seen = this.#db().requestIndex.get(requestId);
    if (seen) {
      if (seen.hash === hash) return { status: "duplicate", seen };
      const alreadyFlagged = this.#db().reviews.some((r) => r.request_id === requestId && r.hash === hash);
      if (!alreadyFlagged) {
        await this.#commit([
          this.#envelope(
            "REVIEW_FLAGGED",
            `review:${requestId}`,
            {
              request_id: requestId,
              kind,
              hash,
              prior_hash: seen.hash,
              prior_effect_event_id: seen.effect_event_id,
              reason: "同编号重传内容与首次不一致",
            },
            this.now(),
          ),
        ]);
      }
      return { status: "review", seen };
    }
    return { status: "new" };
  }

  /* ---------------------------- 查询投影 ---------------------------- */

  passport(passportId) {
    const state = this.#requirePassport(passportId);
    return buildPassportView(this.#db(), state);
  }

  passports() {
    return [...passportsView(this.#db()).values()];
  }

  estimatePerformance(passportId, performanceId) {
    const state = this.#requirePassport(passportId);
    const perf = state.performances.get(performanceId);
    if (!perf) throw new ModelError("UNKNOWN_PERFORMANCE", `演出不存在：${performanceId}`);
    const overall = balances(state);
    const runs = [...perf.runs.values()]
      .filter((r) => r.plan_revision === perf.plan_revision)
      .map((run) => estimateRun(this.#db(), state, run));
    return {
      passport_id: passportId,
      performance_id: performanceId,
      plan_revision: perf.plan_revision,
      current_balances: overall,
      runs: runs,
    };
  }

  tracePerformance(passportId, performanceId) {
    return buildPerformanceTrace(this.#db(), passportId, performanceId);
  }

  pendingNotices() {
    return [...this.#db().notices.values()].filter((n) => n.status !== "delivered");
  }

  reviews() {
    return this.#db().reviews;
  }

  #requirePassport(passportId) {
    const state = this.#db().passports.get(passportId);
    if (!state || !state.exists) throw new ModelError("PASSPORT_NOT_OPEN", `护照不存在：${passportId}`);
    return state;
  }

  /* ---------------------------- 复制替身 ---------------------------- */

  async registerSubstitute(input) {
    const at = input.at ?? this.now();
    const payload = {
      substitute_id: requireText(input.substitute_id, "substitute_id"),
      component_id: requireText(input.component_id, "component_id"),
      name: input.name ?? null,
      material: input.material ?? null,
    };
    return this.#commit([this.#envelope("SUBSTITUTE_REGISTERED", payload.substitute_id, payload, at)]);
  }

  /* ---------------------------- 检查发证 ---------------------------- */

  async recordInspection(input) {
    const at = input.at ?? this.now();
    const passportId = requireText(input.passport_id, "passport_id");
    const state = this.#db().passports.get(passportId);
    const quota = sanitizeQuota(input.quota);
    const components = (input.components ?? []).map((c) => {
      if (!c.component_id) throw new ModelError("BAD_INSPECTION", "部件缺少 component_id");
      return {
        component_id: c.component_id,
        name: c.name ?? c.component_id,
        material: c.material ?? null,
        shared_part_id: c.shared_part_id ?? null,
        factors: sanitizeQuota(c.factors ?? { light: 1, tension: 1, transport: 1 }),
      };
    });
    if (!components.length) throw new ModelError("BAD_INSPECTION", "检查至少要登记一个部件");

    const payload = {
      passport_id: passportId,
      puppet_id: requireText(input.puppet_id, "puppet_id"),
      puppet_name: input.puppet_name ?? null,
      inspection_id: requireText(input.inspection_id, "inspection_id"),
      inspected_at: input.inspected_at ?? at,
      predecessor_inspection_id: state?.inspection?.inspection_id ?? null,
      quota,
      components,
      note: input.note ?? null,
    };
    parseTime(payload.inspected_at, "inspected_at");
    return this.#commit([this.#envelope("OBJECT_INSPECTED", passportId, payload, at)], {
      expectedSeq: state?.seq ?? 0,
      passportId,
    });
  }

  /* ---------------------------- 排期与改期 ---------------------------- */

  async planPerformance(input) {
    const at = input.at ?? this.now();
    this.#requirePassport(input.passport_id);
    const runs = (input.runs ?? []).map(normalizeRun);
    if (!runs.length) throw new ModelError("BAD_PLAN", "排期至少包含一个场次/运输段");
    const payload = {
      passport_id: input.passport_id,
      performance_id: requireText(input.performance_id, "performance_id"),
      troupe_id: requireText(input.troupe_id, "troupe_id"),
      title: input.title ?? null,
      runs,
    };
    return this.#commit([this.#envelope("PERFORMANCE_PLANNED", payload.performance_id, payload, at)]);
  }

  /**
   * 改期：对已确认且未完成的场次，先在同一批次里原子取消（释放占用与预留额度），
   * 再追加新版本排期。已完成的演出保持当时依据，不参与改期。
   */
  async reschedulePerformance(input) {
    const at = input.at ?? this.now();
    const state = this.#requirePassport(input.passport_id);
    const perf = state.performances.get(input.performance_id);
    if (!perf) throw new ModelError("UNKNOWN_PERFORMANCE", `演出不存在：${input.performance_id}`);
    const runs = (input.runs ?? []).map(normalizeRun);
    if (!runs.length) throw new ModelError("BAD_PLAN", "改期排期至少包含一个场次/运输段");

    const events = [];
    for (const run of perf.runs.values()) {
      if (run.plan_revision !== perf.plan_revision || run.status !== "confirmed") continue;
      events.push(
        this.#envelope(
          "STAGE_USE_CANCELLED",
          input.performance_id,
          {
            passport_id: input.passport_id,
            performance_id: input.performance_id,
            run_id: run.run_id,
            reason: "改期换版，取消旧版本确认",
          },
          at,
        ),
      );
    }
    events.push(
      this.#envelope(
        "PERFORMANCE_RESCHEDULED",
        input.performance_id,
        {
          passport_id: input.passport_id,
          performance_id: input.performance_id,
          plan_revision: perf.plan_revision + 1,
          runs,
        },
        at,
      ),
    );
    return this.#commit(events, { expectedSeq: state.seq, passportId: input.passport_id });
  }

  /* ---------------------------- 场次确认 ---------------------------- */

  /**
   * 保护员确认使用方式。entries 中每个部件给出：
   *  mode: original（原件）/ substitute（复制替身）/ repair（修复后原件，复检后使用）
   *  substitute_id: 替身编号（mode=substitute 时必填）
   */
  async confirmUse(input) {
    const at = input.at ?? this.now();
    const requestId = input.request_id ?? null;
    const entries = normalizeEntries(input.entries);
    const hash = this.#requestHash("confirm_use", requestId, strip(input, ["at"]));
    const dedup = await this.#dedupRequest("confirm_use", requestId, hash);
    if (dedup.status !== "new") return dedup;

    const state = this.#requirePassport(input.passport_id);
    const runState = state.performances.get(input.performance_id)?.runs.get(input.run_id);
    if (!runState) throw new ModelError("UNKNOWN_RUN", `场次不存在：${input.run_id}`);

    const confirmEvent = this.#envelope(
      "STAGE_USE_CONFIRMED",
      input.performance_id,
      {
        passport_id: input.passport_id,
        performance_id: input.performance_id,
        run_id: input.run_id,
        plan_revision: runState.plan_revision,
        entries,
        approver: requireText(input.approver, "approver"),
        note: input.note ?? null,
      },
      at,
    );
    const events = [confirmEvent];
    if (requestId) {
      events.push(
        this.#envelope(
          "REQUEST_RECORDED",
          `request:${requestId}`,
          {
            request_id: requestId,
            kind: "confirm_use",
            hash,
            effect_event_id: confirmEvent.event_id,
          },
          at,
        ),
      );
    }
    return this.#commit(events, { expectedSeq: state.seq, passportId: input.passport_id });
  }

  async cancelUse(input) {
    const at = input.at ?? this.now();
    const state = this.#requirePassport(input.passport_id);
    return this.#commit(
      [
        this.#envelope(
          "STAGE_USE_CANCELLED",
          input.performance_id,
          {
            passport_id: input.passport_id,
            performance_id: requireText(input.performance_id, "performance_id"),
            run_id: requireText(input.run_id, "run_id"),
            reason: input.reason ?? "保护员取消",
          },
          at,
        ),
      ],
      { expectedSeq: state.seq, passportId: input.passport_id },
    );
  }

  /* ---------------------------- 现场异常与候补 ---------------------------- */

  /**
   * 现场异常（可定位到部件的局部损伤）：
   * 同一批次原子完成：登记损伤 → 暂停涉及剧团的后续场次 → 通知各剧团。
   * 只影响该古件与后续场次；已完成演出不改动。
   */
  async reportDamage(input) {
    const at = input.at ?? this.now();
    const state = this.#requirePassport(input.passport_id);
    if (!input.components?.length) throw new ModelError("BAD_DAMAGE", "损伤报告至少标注一个部件");
    const perf = state.performances.get(input.performance_id);
    if (!perf) throw new ModelError("UNKNOWN_PERFORMANCE", `演出不存在：${input.performance_id}`);
    const run = perf.runs.get(input.run_id);
    if (!run) throw new ModelError("UNKNOWN_RUN", `场次不存在：${input.run_id}`);

    const events = [];
    events.push(
      this.#envelope(
        "DAMAGE_REPORTED",
        input.passport_id,
        {
          passport_id: input.passport_id,
          damage_report_id: requireText(input.damage_report_id, "damage_report_id"),
          performance_id: input.performance_id,
          run_id: input.run_id,
          components: [...input.components],
          note: input.note ?? null,
        },
        at,
      ),
    );

    // 试算损伤落定后，哪些演出的后续场次会被暂停，据此补暂停事件与通知（全部同批原子）。
    const draft = await this.#preview(events);
    const pauseFrom = parseTime(at);
    for (const [pid, otherPerf] of draft.passports.get(input.passport_id).performances) {
      if (pid === input.performance_id) {
        const otherPaused = [...otherPerf.runs.values()].filter(
          (r) => r.run_id !== input.run_id && r.status === "paused" && parseTime(r.to) > pauseFrom,
        ).map((r) => r.run_id);
        events.push(
          this.#envelope(
            "NOTIFICATION_QUEUED",
            `notice:${input.damage_report_id}:${pid}`,
            {
              notice_id: `notice:${input.damage_report_id}:${pid}`,
              passport_id: input.passport_id,
              performance_id: pid,
              troupe_id: otherPerf.troupe_id,
              kind: otherPaused.length ? "RUN_INTERRUPTED_AND_PAUSED" : "RUN_INTERRUPTED",
              message: `古件 ${input.passport_id} 在《${otherPerf.title ?? pid}》现场发生局部损伤（${input.components.join("、")}），本场中断并进入修复流程${otherPaused.length ? `，后续场次 ${otherPaused.join("、")} 暂停` : ""}`,
              run_ids: [input.run_id, ...otherPaused],
            },
            at,
          ),
        );
        continue;
      }
      const futureRuns = [...otherPerf.runs.values()].filter(
        (r) => r.status === "paused" && parseTime(r.to) > pauseFrom,
      );
      if (!futureRuns.length) continue;
      events.push(
        this.#envelope(
          "PERFORMANCE_PAUSED",
          pid,
          {
            passport_id: input.passport_id,
            performance_id: pid,
            reason: `关联古件现场异常：${input.damage_report_id}`,
            run_ids: futureRuns.map((r) => r.run_id),
          },
          at,
        ),
      );
      events.push(
        this.#envelope(
          "NOTIFICATION_QUEUED",
          `notice:${input.damage_report_id}:${pid}`,
          {
            notice_id: `notice:${input.damage_report_id}:${pid}`,
            passport_id: input.passport_id,
            performance_id: pid,
            troupe_id: otherPerf.troupe_id,
            kind: "FUTURE_RUNS_PAUSED",
            message: `古件 ${input.passport_id} 现场异常，贵团《${otherPerf.title ?? pid}》后续场次暂停，等待修复复检与候补方案`,
            run_ids: futureRuns.map((r) => r.run_id),
          },
          at,
        ),
      );
    }
    return this.#commit(events, { expectedSeq: state.seq, passportId: input.passport_id });
  }

  async activateStandby(input) {
    const at = input.at ?? this.now();
    const state = this.#requirePassport(input.passport_id);
    const basis = input.basis ?? "full_substitute";
    if (!["full_substitute", "local_replacement"].includes(basis)) {
      throw new ModelError("BAD_STANDBY", "候补方案必须是 full_substitute 或 local_replacement");
    }
    return this.#commit(
      [
        this.#envelope(
          "STANDBY_ACTIVATED",
          input.performance_id,
          {
            passport_id: input.passport_id,
            performance_id: requireText(input.performance_id, "performance_id"),
            basis,
            approver: requireText(input.approver, "approver"),
            note: input.note ?? null,
          },
          at,
        ),
      ],
      { expectedSeq: state.seq, passportId: input.passport_id },
    );
  }

  /* ---------------------------- 修复：双人签认 + 复检恢复 ---------------------------- */

  async planRepair(input) {
    const at = input.at ?? this.now();
    const state = this.#requirePassport(input.passport_id);
    return this.#commit(
      [
        this.#envelope(
          "REPAIR_PLANNED",
          input.repair_id,
          {
            passport_id: input.passport_id,
            repair_id: requireText(input.repair_id, "repair_id"),
            damage_report_id: requireText(input.damage_report_id, "damage_report_id"),
            components: [...requireTextList(input.components, "components")],
            plan: input.plan ?? {},
            signer: requireText(input.signer, "signer（首签保护员）"),
          },
          at,
        ),
      ],
      { expectedSeq: state.seq, passportId: input.passport_id },
    );
  }

  async signRepair(input) {
    const at = input.at ?? this.now();
    const state = this.#requirePassport(input.passport_id);
    const repair = state.repairs.get(input.repair_id);
    if (!repair) throw new ModelError("UNKNOWN_REPAIR", `修复方案不存在：${input.repair_id}`);
    if (repair.signers.some((s) => s.signer === input.signer)) {
      throw new ModelError("SIGNER_DUPLICATE", `签认人不能重复：${input.signer}`);
    }
    return this.#commit(
      [
        this.#envelope(
          "REPAIR_SIGN_RECORDED",
          input.repair_id,
          {
            passport_id: input.passport_id,
            repair_id: input.repair_id,
            signer: requireText(input.signer, "signer（复核保护员）"),
          },
          at,
        ),
      ],
      { expectedSeq: state.seq, passportId: input.passport_id },
    );
  }

  /**
   * 双人签认通过后批准恢复：解除暂停、设定观察期，但额度必须等新检查结果（recordInspection）才恢复。
   * 历史台账与累计负荷保留，不清空。
   */
  async approveRestoration(input) {
    const at = input.at ?? this.now();
    const state = this.#requirePassport(input.passport_id);
    const repair = state.repairs.get(input.repair_id);
    if (!repair) throw new ModelError("UNKNOWN_REPAIR", `修复方案不存在：${input.repair_id}`);
    if (repair.signers.length < 2) throw new ModelError("NEED_TWO_SIGNERS", "修复方案须经两名保护员签认");
    const observations = (input.observations ?? []).map((o) => ({
      component_id: requireText(o.component_id, "component_id"),
      until: requireText(o.until, "观察期截止 until"),
    }));
    for (const o of observations) parseTime(o.until, "观察期截止 until");

    const events = [
      this.#envelope(
        "RESTORATION_APPROVED",
        input.repair_id,
        {
          passport_id: input.passport_id,
          repair_id: input.repair_id,
          observations,
        },
        at,
      ),
    ];
    // 损伤时暂停的各剧团演出同步解除暂停（回到待确认，凭复检版本重新确认）。
    for (const [pid, perf] of state.performances) {
      const hasPaused = perf.damage_paused === true || [...perf.runs.values()].some((r) => r.paused_by_damage);
      if (hasPaused) {
        events.push(
          this.#envelope(
            "PERFORMANCE_RESUMED",
            pid,
            { passport_id: input.passport_id, performance_id: pid, reason: "修复签认通过，等待复检版本" },
            at,
          ),
        );
      }
    }
    return this.#commit(events, { expectedSeq: state.seq, passportId: input.passport_id });
  }

  /* ---------------------------- 离线完成回执 ---------------------------- */

  /**
   * 现场离线回执场次完成。receipt_id 由现场生成（同编号重传不重复扣减）。
   * 已完成的演出保持确认当时的负荷依据，回执不再重算负荷。
   */
  async completeRun(input) {
    const at = input.at ?? this.now();
    const receiptId = requireText(input.receipt_id, "receipt_id");
    const hash = this.#requestHash("stage_completed", receiptId, strip(input, ["at"]));
    const dedup = await this.#dedupRequest("stage_completed", receiptId, hash);
    if (dedup.status !== "new") return dedup;

    const state = this.#requirePassport(input.passport_id);
    const run = state.performances.get(input.performance_id)?.runs.get(input.run_id);
    if (!run) throw new ModelError("UNKNOWN_RUN", `场次不存在：${input.run_id}`);

    const completedEvent = this.#envelope(
      "STAGE_COMPLETED",
      input.performance_id,
      {
        passport_id: input.passport_id,
        performance_id: input.performance_id,
        run_id: input.run_id,
        plan_revision: run.plan_revision,
        receipt_id: receiptId,
      },
      at,
    );
    const indexEvent = this.#envelope(
      "REQUEST_RECORDED",
      `request:${receiptId}`,
      {
        request_id: receiptId,
        kind: "stage_completed",
        hash,
        effect_event_id: completedEvent.event_id,
      },
      at,
    );
    return this.#commit(
      [completedEvent, indexEvent],
      { expectedSeq: state.seq, passportId: input.passport_id },
    );
  }

  /* ---------------------------- 通知 outbox 投递 ---------------------------- */

  /**
   * 投递所有未完成通知。sink 为异步函数；成功记 DELIVERED，失败记 FAILED 并保留待重试。
   * 服务重启后重新调用即可继续未完成通知。
   */
  async deliverPendingNotices(sink) {
    const results = [];
    for (const notice of this.pendingNotices()) {
      try {
        const result = await sink(notice);
        await this.#commit([
          this.#envelope(
            "NOTIFICATION_DELIVERED",
            notice.notice_id,
            { notice_id: notice.notice_id, result: result ?? null },
            this.now(),
          ),
        ]);
        results.push({ notice_id: notice.notice_id, delivered: true });
      } catch (err) {
        await this.#commit([
          this.#envelope(
            "NOTIFICATION_DELIVERY_FAILED",
            notice.notice_id,
            { notice_id: notice.notice_id, error: String(err?.message ?? err) },
            this.now(),
          ),
        ]);
        results.push({ notice_id: notice.notice_id, delivered: false, error: String(err?.message ?? err) });
      }
    }
    return results;
  }

  /** 在内存中预折叠一组事件（不落盘），供同批决策使用。 */
  async #preview(events) {
    const { foldEvents } = await import("./model.js");
    return foldEvents([...this.store.allEvents(), ...events]);
  }
}

/* ------------------------------ 输入校验辅助 ------------------------------ */

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new ModelError("BAD_INPUT", `字段必填：${field}`);
  return value;
}

function requireTextList(value, field) {
  if (!Array.isArray(value) || !value.length) throw new ModelError("BAD_INPUT", `字段必填且非空：${field}`);
  return value.map((v) => requireText(v, field));
}

function sanitizeQuota(quota) {
  if (!quota || typeof quota !== "object") throw new ModelError("BAD_INPUT", "缺少额度 quota");
  const out = {};
  for (const dim of LOAD_DIMENSIONS) {
    const value = quota[dim];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new ModelError("BAD_INPUT", `额度 ${dim} 必须为非负数字`);
    }
    out[dim] = value;
  }
  return out;
}

function normalizeRun(run) {
  if (!run.run_id) throw new ModelError("BAD_PLAN", "场次缺少 run_id");
  const kind = run.kind ?? "show";
  if (!["rehearsal", "show", "transit"].includes(kind)) {
    throw new ModelError("BAD_PLAN", `场次类型非法：${kind}`);
  }
  if (!run.from || !run.to) throw new ModelError("BAD_PLAN", `场次 ${run.run_id} 缺少起止时间`);
  const from = parseTime(run.from, "from");
  const to = parseTime(run.to, "to");
  if (to <= from) throw new ModelError("BAD_PLAN", `场次 ${run.run_id} 结束时间必须晚于开始时间`);
  return {
    run_id: run.run_id,
    kind,
    stage: kind === "show" ? run.stage ?? "performance" : kind === "rehearsal" ? "rehearsal" : "transit",
    from: run.from,
    to: run.to,
  };
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new ModelError("BAD_INPUT", "至少确认一个部件的使用方式");
  return entries.map((entry) => {
    const mode = entry.mode;
    if (!["original", "substitute", "repair"].includes(mode)) {
      throw new ModelError("BAD_INPUT", `使用方式非法：${mode}`);
    }
    const out = {
      component_id: requireText(entry.component_id, "component_id"),
      mode,
      substitute_id: null,
    };
    if (mode === "substitute") out.substitute_id = requireText(entry.substitute_id, "substitute_id");
    return out;
  });
}

function strip(obj, keys) {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}
