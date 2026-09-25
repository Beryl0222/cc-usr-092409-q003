import { randomUUID } from "node:crypto";

import { EventStore } from "./event-store.js";
import { EVENT_TYPES, contentHash, makeEvent } from "./events.js";
import {
  estimateUsage,
  reconcileActual,
  addLoad,
  zeroLoad,
  withinQuota,
} from "./load.js";
import {
  fold,
  nextVersion,
  findComponentConflicts,
  usedOnCurrentVersion,
  inObservation,
} from "./projection.js";
import {
  DECISIONS,
  LOAD_DIMENSIONS,
  OBSERVATION_HOURS,
  OBSERVATION_QUOTA_RATIO,
  quotaForLevel,
} from "./constants.js";

export class DomainError extends Error {}

function isoNow() {
  return new Date().toISOString();
}

function hoursFromNowIso(nowIso, hours) {
  return new Date(new Date(nowIso).getTime() + hours * 3_600_000).toISOString();
}

/** 场次方案的 snake_case 字段映射为负荷估算器使用的形状。 */
function toEstimatePlan(scheme, mode) {
  return {
    lightMinutes: scheme.light_minutes ?? 0,
    tensionMinutes: scheme.tension_minutes ?? 0,
    environmentMinutes: scheme.environment_minutes ?? 0,
    transportKm: scheme.transport_km ?? 0,
    transportLegs: scheme.transport_legs ?? 1,
    lightMode: scheme.light_mode ?? "normal",
    mode,
    startsAt: scheme.starts_at,
  };
}

/**
 * 演出负荷护照应用服务。
 *
 * 所有状态来自追加式事件日志：每次提交后重新 fold，
 * 因此用同一文件重新构造服务即可模拟“服务重启后继续”。
 */
export class PassportService {
  constructor(storeFile) {
    this.store = new EventStore(storeFile);
    this.reload();
  }

  reload() {
    this.state = fold(this.store.load());
    return this.state;
  }

  // ------------------------------------------------------------
  // 基础登记
  // ------------------------------------------------------------

  /**
   * 登记一次古件检查（初检/例行复检/修复后复检）。
   * 每次检查产生一个检查版本与该版本下的额度。
   */
  inspectObject(cmd) {
    const at = cmd.now ?? isoNow();
    const object = this.state.objects.get(cmd.object_id);
    const version = cmd.inspection.version ?? (object ? object.inspections.length + 1 : 1);
    if (object && object.inspections.some((i) => i.version === version)) {
      throw new DomainError(`检查版本 ${version} 已存在，业务更正须产生新版本`);
    }
    const level = cmd.inspection.vulnerability_level;
    const inspection = {
      version,
      inspected_at: cmd.inspection.inspected_at ?? at,
      inspector_id: cmd.inspection.inspector_id,
      vulnerability_level: level,
      vulnerabilities: cmd.inspection.vulnerabilities ?? [],
      component_ids: cmd.inspection.component_ids ?? [],
      quota: cmd.inspection.quota ?? quotaForLevel(level),
      kind: cmd.inspection.kind ?? (object ? "routine" : "initial"),
      repair_id: cmd.inspection.repair_id ?? null,
    };
    const event = makeEvent(
      EVENT_TYPES.OBJECT_INSPECTED,
      "puppet_object",
      cmd.object_id,
      {
        summary: cmd.summary ?? `古件 ${cmd.object_id} 检查版本 ${version}`,
        object_id: cmd.object_id,
        name: cmd.name,
        inspection,
      },
      { occurredAt: at, extra: cmd.client_message_id ? { client_message_id: cmd.client_message_id } : undefined }
    );
    return this.commit([event], { clientMessageId: cmd.client_message_id, content: cmd, at });
  }

  /** 登记整件复制替身或局部替换件。 */
  registerSubstitute(cmd) {
    const at = cmd.now ?? isoNow();
    if (this.state.substitutes.has(cmd.substitute_id)) {
      throw new DomainError(`替身 ${cmd.substitute_id} 已登记`);
    }
    const event = makeEvent(
      EVENT_TYPES.SUBSTITUTE_ASSIGNED,
      "substitute",
      cmd.substitute_id,
      {
        summary: cmd.note ?? `登记替身 ${cmd.substitute_id}`,
        substitute_id: cmd.substitute_id,
        object_id: cmd.object_id ?? null,
        scope: cmd.scope,
        part_ids: cmd.part_ids ?? [],
        note: cmd.note ?? "",
      },
      { occurredAt: at }
    );
    return this.commit([event], { at });
  }

  /** 排定一场演出/排练。 */
  planPerformance(cmd) {
    const at = cmd.now ?? isoNow();
    if (this.state.plans.has(cmd.plan_id)) {
      throw new DomainError(`场次 ${cmd.plan_id} 已存在`);
    }
    const event = makeEvent(
      EVENT_TYPES.PERFORMANCE_PLANNED,
      "performance_plan",
      cmd.plan_id,
      {
        summary: cmd.name,
        plan_id: cmd.plan_id,
        name: cmd.name,
        troupe_id: cmd.troupe_id,
        troupe_name: cmd.troupe_name,
        starts_at: cmd.starts_at,
        ends_at: cmd.ends_at,
        venue: cmd.venue ?? "",
      },
      { occurredAt: at }
    );
    return this.commit([event], { at });
  }

  // ------------------------------------------------------------
  // 预约与排期：先算消耗，再由保护员确认
  // ------------------------------------------------------------

  /**
   * 剧团为某场次申请使用某古件。
   * 仅登记申请与负荷估算，不占用部件；占用发生在保护员签认时。
   * 返回估算消耗、连续使用判定与额度预判，供保护员选择原件/替身/局部替换。
   */
  requestBooking(cmd) {
    const at = cmd.now ?? isoNow();
    this.requireObject(cmd.object_id);
    this.requirePlan(cmd.plan_id);
    if (this.state.bookings.has(cmd.booking_id)) {
      throw new DomainError(`预约 ${cmd.booking_id} 已存在`);
    }
    const object = this.state.objects.get(cmd.object_id);
    const scheme = { ...cmd.scheme, starts_at: cmd.scheme.starts_at, ends_at: cmd.scheme.ends_at };
    const previousEnd = this.previousUsageEnd(cmd.object_id, scheme.starts_at, null);
    const estimated = estimateUsage(
      { ...toEstimatePlan(scheme, "original"), startsAt: scheme.starts_at },
      previousEnd
    );
    const used = usedOnCurrentVersion(object);
    const projected = addLoad(used, estimated);
    const quota = this.effectiveQuota(object, scheme.starts_at);

    const event = makeEvent(
      EVENT_TYPES.BOOKING_REQUESTED,
      "booking",
      cmd.booking_id,
      {
        summary: `${cmd.troupe_id} 申请在 ${cmd.plan_id} 使用 ${cmd.object_id}`,
        booking_id: cmd.booking_id,
        plan_id: cmd.plan_id,
        troupe_id: cmd.troupe_id,
        object_id: cmd.object_id,
        requested_by: cmd.requested_by,
        scheme,
        estimated_load: estimated,
        at_inspection_version: object.currentVersion,
      },
      { occurredAt: at }
    );
    const result = this.commit([event], {
      clientMessageId: cmd.client_message_id,
      content: cmd,
      at,
    });
    return {
      ...result,
      assessment: {
        inspection_version: object.currentVersion,
        used,
        estimated_load: estimated,
        projected_load: projected,
        quota,
        within_quota: withinQuota(projected, quota),
        previous_usage_ends_at: previousEnd,
        continuous_use: estimated._recoveryGapHours !== undefined,
      },
    };
  }

  /**
   * 保护员签认：决定原件 / 复制替身 / 局部替换 / 驳回。
   * 原件与局部替换会原子占用方案涉及部件：任一部件在时间窗内已被其他方案占用，则整批拒绝。
   */
  decideBooking(cmd) {
    const at = cmd.now ?? isoNow();
    const booking = this.requireBooking(cmd.booking_id);
    const object = this.requireObject(booking.object_id);
    if (booking.status === "used" || booking.status === "cancelled") {
      throw new DomainError(`预约 ${cmd.booking_id} 已${booking.status === "used" ? "完成" : "取消"}，不能再签认`);
    }
    if (![DECISIONS.ORIGINAL, DECISIONS.SUBSTITUTE, DECISIONS.PARTIAL, DECISIONS.REJECTED].includes(cmd.decision)) {
      throw new DomainError(`未知使用决定：${cmd.decision}`);
    }

    const scheme = booking.scheme;
    const mode = cmd.decision === "rejected" ? "original" : cmd.decision;
    const estimated =
      cmd.decision === "substitute"
        ? zeroLoad()
        : estimateUsage(
            { ...toEstimatePlan(scheme, mode), startsAt: booking.starts_at },
            this.previousUsageEnd(object.object_id, booking.starts_at, booking.booking_id)
          );

    let componentsLocked = [];
    const quota = this.effectiveQuota(object, booking.starts_at);

    const observing = inObservation(object, booking.starts_at);
    if (observing && (cmd.decision === "original" || cmd.decision === "partial") && !cmd.observation_acknowledged) {
      throw new DomainError("古件处于修复后观察期，原件使用须明确确认观察期限制");
    }

    if (cmd.decision === "original" || cmd.decision === "partial") {
      const damaged = this.openIncidentParts(object.object_id);
      const hasWholeIncident = [...this.state.incidents.values()].some(
        (i) => i.object_id === object.object_id && i.status === "open" && !(i.part_ids?.length)
      );
      // 整件异常未关闭前，原件一律停用；局部异常仅拦截涉损部件（替身或不涉损场次可继续）。
      if (hasWholeIncident) {
        throw new DomainError(`古件 ${object.object_id} 存在未关闭的整件异常，只能使用替身`);
      }
      if (cmd.decision === "partial") {
        const replaced = new Set(cmd.replaced_part_ids ?? scheme.replaced_part_ids ?? []);
        componentsLocked = (scheme.part_ids ?? []).filter((p) => !replaced.has(p));
      } else {
        componentsLocked = [...(scheme.part_ids ?? [])];
      }
      // 局部损伤复演：受损部件不能作为原件部件。
      const touchingDamaged = componentsLocked.filter((p) => damaged.has(p));
      if (touchingDamaged.length) {
        throw new DomainError(`部件仍在异常影响范围：${touchingDamaged.join("、")}，须以替换件承担或等待修复`);
      }
      // 原子占用：所有部件必须同时可用。
      const conflicts = findComponentConflicts(
        this.state,
        componentsLocked,
        booking.starts_at,
        booking.ends_at,
        booking.booking_id
      );
      if (conflicts.length) {
        const err = new DomainError(
          `部件被其他方案占用：${conflicts.map((c) => `${c.part_id}→${c.blocking_booking_id}`).join("、")}`
        );
        err.code = "COMPONENT_CONFLICT";
        err.conflicts = conflicts;
        throw err;
      }
      // 额度校验：当前检查周期已用 + 本场估算 不得超过有效额度。
      const projected = addLoad(usedOnCurrentVersion(object), estimated);
      if (!withinQuota(projected, quota)) {
        const err = new DomainError(`超出检查版本 ${object.currentVersion} 的可用额度，建议改用复制替身或局部替换`);
        err.code = "QUOTA_EXCEEDED";
        err.projected_load = projected;
        err.quota = quota;
        throw err;
      }
    }

    const event = makeEvent(
      EVENT_TYPES.BOOKING_DECIDED,
      "booking",
      booking.booking_id,
      {
        summary: `保护员 ${cmd.decided_by} 决定 ${cmd.decision}`,
        booking_id: booking.booking_id,
        plan_id: booking.plan_id,
        decision: cmd.decision,
        decided_by: cmd.decided_by,
        components_locked: componentsLocked,
        substitutes: cmd.substitutes ?? [],
        estimated_load: estimated,
        inspection_version: object.currentVersion,
        quota_at_decision: quota,
        observation_acknowledged: cmd.observation_acknowledged ?? false,
        note: cmd.note ?? "",
      },
      { occurredAt: at }
    );
    return this.commit([event], { at });
  }

  /**
   * 跨团改期：重新估算连续使用/运输/环境消耗并重新原子占用部件。
   * 若新窗口与其他剧团方案冲突，改期整体失败，原占用保持不变。
   */
  rescheduleBooking(cmd) {
    const at = cmd.now ?? isoNow();
    const booking = this.requireBooking(cmd.booking_id);
    if (booking.status === "used" || booking.status === "cancelled") {
      throw new DomainError("已完成或已取消的场次不能改期");
    }
    const object = this.requireObject(booking.object_id);
    const newScheme = cmd.new_scheme
      ? { ...booking.scheme, ...cmd.new_scheme, starts_at: cmd.new_starts_at, ends_at: cmd.new_ends_at }
      : { ...booking.scheme, starts_at: cmd.new_starts_at, ends_at: cmd.new_ends_at };

    const lastDecision = booking.decisions[booking.decisions.length - 1];
    const mode = lastDecision && booking.status === "confirmed" ? lastDecision.decision : "original";
    const estimated =
      mode === "substitute"
        ? zeroLoad()
        : estimateUsage(
            { ...toEstimatePlan(newScheme, mode), startsAt: cmd.new_starts_at },
            this.previousUsageEnd(object.object_id, cmd.new_starts_at, booking.booking_id)
          );

    // 改期前先做部件冲突预检：失败则不写入任何事件。
    if (booking.status === "confirmed" && mode !== "substitute") {
      let components = lastDecision?.components ?? [];
      if (mode === "partial") {
        const replaced = new Set(newScheme.replaced_part_ids ?? []);
        components = (newScheme.part_ids ?? []).filter((p) => !replaced.has(p));
      }
      const conflicts = findComponentConflicts(
        this.state,
        components,
        cmd.new_starts_at,
        cmd.new_ends_at,
        booking.booking_id
      );
      if (conflicts.length) {
        const err = new DomainError(
          `改期失败，部件在新时间窗被占用：${conflicts.map((c) => `${c.part_id}→${c.blocking_booking_id}`).join("、")}`
        );
        err.code = "COMPONENT_CONFLICT";
        err.conflicts = conflicts;
        throw err;
      }
      // 新窗口的疲劳重算后仍须满足当前检查版本额度。
      const projected = addLoad(usedOnCurrentVersion(object), estimated);
      const quota = this.effectiveQuota(object, cmd.new_starts_at);
      if (!withinQuota(projected, quota)) {
        const err = new DomainError("改期后连续使用等消耗超出可用额度，须改用替身或局部替换");
        err.code = "QUOTA_EXCEEDED";
        err.projected_load = projected;
        err.quota = quota;
        throw err;
      }
    }

    const event = makeEvent(
      EVENT_TYPES.BOOKING_RESCHEDULED,
      "booking",
      booking.booking_id,
      {
        summary: `改期至 ${cmd.new_starts_at}（${cmd.changed_by ?? "未记录"}）`,
        booking_id: cmd.booking_id,
        new_plan_id: cmd.new_plan_id ?? null,
        new_starts_at: cmd.new_starts_at,
        new_ends_at: cmd.new_ends_at,
        new_scheme: cmd.new_scheme ?? null,
        estimated_load: estimated,
        changed_by: cmd.changed_by ?? null,
      },
      { occurredAt: at }
    );
    return this.commit([event], { at });
  }

  cancelBooking(cmd) {
    const at = cmd.now ?? isoNow();
    const booking = this.requireBooking(cmd.booking_id);
    const event = makeEvent(
      EVENT_TYPES.BOOKING_CANCELLED,
      "booking",
      booking.booking_id,
      {
        summary: cmd.reason ?? "取消预约并释放占用",
        booking_id: cmd.booking_id,
        reason: cmd.reason ?? "",
        cancelled_by: cmd.cancelled_by ?? null,
      },
      { occurredAt: at }
    );
    return this.commit([event], { at });
  }

  // ------------------------------------------------------------
  // 现场：离线回执、异常、候补
  // ------------------------------------------------------------

  /**
   * 记录现场回执（可能离线后补传）。
   *
   * 幂等规则：
   * - 同一 client_message_id 重传且内容一致：直接返回首次凭证，不再产生事件、不重复扣减。
   * - 同一 client_message_id 但内容哈希变化：不扣减，开启保全复核。
   * - receipt_id 同样唯一，防止绕过消息编号重放。
   */
  recordUsage(cmd) {
    const at = cmd.now ?? isoNow();
    if (!cmd.client_message_id) throw new DomainError("现场回执必须带 client_message_id");
    if (!cmd.receipt_id) throw new DomainError("现场回执必须带 receipt_id");

    const known = this.state.ledger.get(cmd.client_message_id);
    const hash = contentHash(stripTransient(cmd));
    if (known) {
      if (known.content_hash === hash) {
        return { duplicate: true, receipt: known, events: [] };
      }
      return this.openReview({
        reason: "同编号重传内容发生变化",
        client_message_id: cmd.client_message_id,
        original_hash: known.content_hash,
        received_hash: hash,
        payload: stripTransient(cmd),
        now: at,
      });
    }
    if (this.state.receipts.has(cmd.receipt_id)) {
      return this.openReview({
        reason: "回执编号已用于不同消息",
        receipt_id: cmd.receipt_id,
        received_hash: hash,
        payload: stripTransient(cmd),
        now: at,
      });
    }

    const booking = this.requireBooking(cmd.booking_id);
    const kind = cmd.kind ?? "actual";
    const allowed = kind === "adjustment" ? ["confirmed", "used"] : ["confirmed"];
    if (!allowed.includes(booking.status)) {
      throw new DomainError(`预约状态为 ${booking.status}，当前回执类型（${kind}）不能记录`);
    }
    const decision = [...booking.decisions].reverse().find((d) => d.decision !== "rejected");
    const estimated = decision?.estimated_load ?? booking.estimated_load ?? zeroLoad();
    // 调整单携带的是逐维度修正增量（可负），缺失维度按 0；普通回执缺失维度回退估算。
    const actualLoad =
      kind === "adjustment"
        ? { ...zeroLoad(), ...(cmd.actual_load ?? {}) }
        : reconcileActual(estimated, cmd.actual_load);
    const object = this.requireObject(booking.object_id);

    const event = makeEvent(
      EVENT_TYPES.USAGE_RECORDED,
      "booking",
      booking.booking_id,
      {
        summary: cmd.summary ?? `回执 ${cmd.receipt_id}：${cmd.recorded_mode} 实际使用`,
        booking_id: booking.booking_id,
        object_id: booking.object_id,
        plan_id: booking.plan_id,
        troupe_id: booking.troupe_id,
        receipt_id: cmd.receipt_id,
        kind, // actual=本场回执，adjustment=事后调整单
        recorded_mode: cmd.recorded_mode, // original | partial | substitute
        actual_components: cmd.actual_components ?? [],
        actual_substitutes: cmd.actual_substitutes ?? [],
        estimated_load: estimated,
        actual_load: actualLoad,
        used_at: cmd.used_at ?? at,
        evidence: {
          inspection_version: cmd.inspection_version ?? object.currentVersion,
          quota_snapshot: decision?.quota_at_decision ?? null,
          references: cmd.evidence_refs ?? [],
          note: cmd.evidence_note ?? "",
        },
        recorded_by: cmd.recorded_by ?? null,
        client_message_id: cmd.client_message_id,
        content_hash: hash,
      },
      { occurredAt: at }
    );
    return this.commit([event], { clientMessageId: cmd.client_message_id, content: stripTransient(cmd), at });
  }

  /**
   * 现场异常：只暂停相关古件与其“后续”场次，已完成演出保持当时依据不动。
   * - 整件异常（不带 part_ids）：暂停该古件所有未完成的原件/局部场次。
   * - 局部异常（带 part_ids）：仅暂停方案占用了受损部件的场次；使用替身或不涉损部件的场次继续。
   */
  reportIncident(cmd) {
    const at = cmd.now ?? isoNow();
    this.requireObject(cmd.object_id);
    const incidentId = cmd.incident_id ?? `inc-${randomUUID()}`;
    const events = [
      makeEvent(
        EVENT_TYPES.INCIDENT_REPORTED,
        "incident",
        incidentId,
        {
          summary: cmd.reason ?? `现场异常 ${incidentId}`,
          incident_id: incidentId,
          object_id: cmd.object_id,
          part_ids: cmd.part_ids ?? [],
          severity: cmd.severity ?? "minor",
          reported_by: cmd.reported_by,
          booking_id: cmd.booking_id ?? null,
          reason: cmd.reason ?? "",
        },
        { occurredAt: at }
      ),
    ];

    const damaged = new Set(cmd.part_ids ?? []);
    for (const booking of this.state.bookings.values()) {
      if (booking.object_id !== cmd.object_id) continue;
      if (["used", "cancelled", "rejected", "suspended"].includes(booking.status)) continue;
      // 已结束的场次不再暂停；已完成（已有回执）的演出保持当时依据。
      if (new Date(booking.ends_at).getTime() <= new Date(at).getTime()) continue;

      const decision = [...booking.decisions].reverse().find((d) => d.decision !== "rejected");
      const usesOriginal = decision && decision.decision !== "substitute";
      if (!usesOriginal) continue; // 替身场次不受古件异常影响
      if (damaged.size) {
        const locked = new Set(decision.components ?? []);
        if (![...damaged].some((p) => locked.has(p))) continue; // 局部损伤不波及无关场次
      }
      events.push(
        makeEvent(
          EVENT_TYPES.BOOKING_SUSPENDED,
          "booking",
          booking.booking_id,
          {
            summary: `受异常 ${incidentId} 影响暂停`,
            booking_id: booking.booking_id,
            incident_id: incidentId,
            part_ids: cmd.part_ids ?? [],
            reason: "incident",
          },
          { occurredAt: at }
        )
      );
      const noteId = `note-${randomUUID()}`;
      events.push(
        makeEvent(
          EVENT_TYPES.NOTIFICATION_REQUESTED,
          "notification",
          noteId,
          {
            summary: `通知 ${booking.troupe_id}：场次 ${booking.plan_id} 因古件异常暂停`,
            notification_id: noteId,
            booking_id: booking.booking_id,
            troupe_id: booking.troupe_id,
            kind: "booking_suspended",
            incident_id: incidentId,
          },
          { occurredAt: at }
        )
      );
    }
    return this.commit(events, { at, incident_id: incidentId });
  }

  /** 为被暂停场次安排候补替换（整件替身或另一古件）。 */
  assignStandby(cmd) {
    const at = cmd.now ?? isoNow();
    this.requireBooking(cmd.booking_id);
    const event = makeEvent(
      EVENT_TYPES.STANDBY_ASSIGNED,
      "booking",
      cmd.booking_id,
      {
        summary: `候补替换：${cmd.standby_type}`,
        booking_id: cmd.booking_id,
        standby_type: cmd.standby_type, // substitute | another_object
        substitute_ids: cmd.substitute_ids ?? [],
        standby_object_id: cmd.standby_object_id ?? null,
        assigned_by: cmd.assigned_by,
      },
      { occurredAt: at }
    );
    return this.commit([event], { at });
  }

  // ------------------------------------------------------------
  // 修复：双人签认 → 新检查版本恢复额度 → 观察期 → 复演重签
  // ------------------------------------------------------------

  proposeRepair(cmd) {
    const at = cmd.now ?? isoNow();
    this.requireObject(cmd.object_id);
    if (this.state.repairs.has(cmd.repair_id)) throw new DomainError(`修复 ${cmd.repair_id} 已存在`);
    const event = makeEvent(
      EVENT_TYPES.REPAIR_PROPOSED,
      "conservation_action",
      cmd.repair_id,
      {
        summary: cmd.plan ?? `修复方案 ${cmd.repair_id}`,
        repair_id: cmd.repair_id,
        object_id: cmd.object_id,
        incident_id: cmd.incident_id ?? null,
        part_ids: cmd.part_ids ?? [],
        proposed_by: cmd.proposed_by,
        plan: cmd.plan ?? "",
        target_inspection: {
          vulnerability_level: cmd.target_inspection.vulnerability_level,
          vulnerabilities: cmd.target_inspection.vulnerabilities ?? [],
        },
      },
      { occurredAt: at }
    );
    return this.commit([event], { at });
  }

  /** 双人签认：必须是两个不同的自然人；同一人重复签认不计第二次。 */
  signRepair(cmd) {
    const at = cmd.now ?? isoNow();
    const repair = this.requireRepair(cmd.repair_id);
    if (repair.status === "completed") throw new DomainError("修复已完成，不能再补签");
    if (repair.signers.some((s) => s.signer_id === cmd.signer_id)) {
      throw new DomainError(`${cmd.signer_id} 已签认过该修复方案`);
    }
    if (repair.signers.length >= 2) throw new DomainError("修复方案已达到双人签认");
    const event = makeEvent(
      EVENT_TYPES.REPAIR_SIGNED,
      "conservation_action",
      cmd.repair_id,
      {
        summary: `${cmd.signer_id} 签认修复方案`,
        repair_id: cmd.repair_id,
        object_id: repair.object_id,
        signer_id: cmd.signer_id,
        role: cmd.role ?? "conservator",
      },
      { occurredAt: at }
    );
    return this.commit([event], { at });
  }

  /**
   * 双人签认齐备后，凭修复后新检查结果完成修复：
   * - 新检查版本按新结果给额度，旧版本下的历史用量原样保留（不清空历史）；
   * - 开启观察期；
   * - 关闭关联异常；
   * - 受影响的未完成场次须按新检查版本重新签认；
   * - 通知相关剧团。
   * 全部事件同一批次原子提交。
   */
  completeRepair(cmd) {
    const at = cmd.now ?? isoNow();
    const repair = this.requireRepair(cmd.repair_id);
    if (repair.signers.length < 2) {
      throw new DomainError("修复方案须经双人签认后才能按新检查结果恢复额度");
    }
    if (repair.status === "completed") throw new DomainError("修复已完成，历史不可改写");
    const object = this.requireObject(repair.object_id);
    const newVersion = object.inspections.length + 1;
    const observationUntil = hoursFromNowIso(at, OBSERVATION_HOURS);
    const inspection = {
      version: newVersion,
      inspected_at: cmd.inspection.inspected_at ?? at,
      inspector_id: cmd.inspection.inspector_id,
      vulnerability_level: cmd.inspection.vulnerability_level,
      vulnerabilities: cmd.inspection.vulnerabilities ?? repair.target_vulnerabilities,
      component_ids: cmd.inspection.component_ids ?? [],
      quota: cmd.inspection.quota ?? quotaForLevel(cmd.inspection.vulnerability_level),
      kind: "post_repair",
      repair_id: repair.repair_id,
    };

    const events = [
      makeEvent(
        EVENT_TYPES.REPAIR_COMPLETED,
        "conservation_action",
        repair.repair_id,
        {
          summary: `修复完成，启用检查版本 ${newVersion}，进入观察期至 ${observationUntil}`,
          repair_id: repair.repair_id,
          object_id: repair.object_id,
          observation_until: observationUntil,
          new_inspection_version: newVersion,
        },
        { occurredAt: at }
      ),
      makeEvent(
        EVENT_TYPES.OBJECT_INSPECTED,
        "puppet_object",
        repair.object_id,
        {
          summary: `修复后复检版本 ${newVersion}`,
          object_id: repair.object_id,
          inspection,
        },
        { occurredAt: at }
      ),
    ];

    // 关闭该修复涉及的未关闭异常（整件或相关部件）。
    for (const incident of this.state.incidents.values()) {
      if (incident.object_id !== repair.object_id || incident.status !== "open") continue;
      events.push(
        makeEvent(
          EVENT_TYPES.INCIDENT_RESOLVED,
          "incident",
          incident.incident_id,
          {
            summary: `随修复 ${repair.repair_id} 关闭`,
            incident_id: incident.incident_id,
            object_id: repair.object_id,
            repair_id: repair.repair_id,
          },
          { occurredAt: at }
        )
      );
    }

    // 未完成场次：旧检查版本下的签认失效，须按新版本重新签认；被异常暂停的场次解除暂停标记但需重签。
    for (const booking of this.state.bookings.values()) {
      if (booking.object_id !== repair.object_id) continue;
      if (["used", "cancelled", "rejected"].includes(booking.status)) continue;
      events.push(
        makeEvent(
          EVENT_TYPES.BOOKING_RECONFIRM_REQUIRED,
          "booking",
          booking.booking_id,
          {
            summary: `修复后须按检查版本 ${newVersion} 重新签认`,
            booking_id: booking.booking_id,
            reason: "post_repair_new_inspection",
            new_inspection_version: newVersion,
          },
          { occurredAt: at }
        )
      );
      const noteId = `note-${randomUUID()}`;
      events.push(
        makeEvent(
          EVENT_TYPES.NOTIFICATION_REQUESTED,
          "notification",
          noteId,
          {
            summary: `通知 ${booking.troupe_id}：古件修复完成，场次 ${booking.plan_id} 须重新签认`,
            notification_id: noteId,
            booking_id: booking.booking_id,
            troupe_id: booking.troupe_id,
            kind: "reconfirm_required",
            repair_id: repair.repair_id,
          },
          { occurredAt: at }
        )
      );
    }

    return this.commit(events, { at });
  }

  // ------------------------------------------------------------
  // 通知与复核
  // ------------------------------------------------------------

  /** 投递通知（重启后仍可对 pending 通知重试）。 */
  deliverNotification(cmd) {
    const at = cmd.now ?? isoNow();
    const note = [...this.state.notifications].reverse().find((n) => n.notification_id === cmd.notification_id);
    if (!note) throw new DomainError(`通知 ${cmd.notification_id} 不存在`);
    if (note.delivery_status === "delivered") {
      return { duplicate: true, events: [] };
    }
    const event = makeEvent(
      EVENT_TYPES.NOTIFICATION_DELIVERED,
      "notification",
      cmd.notification_id,
      {
        summary: `通知 ${cmd.notification_id} 已投递`,
        notification_id: cmd.notification_id,
        delivered_to: cmd.delivered_to,
        delivered_by: cmd.delivered_by ?? null,
      },
      { occurredAt: at }
    );
    return this.commit([event], { at });
  }

  openReview(cmd) {
    const at = cmd.now ?? isoNow();
    const reviewId = `review-${randomUUID()}`;
    const event = makeEvent(
      EVENT_TYPES.REVIEW_OPENED,
      "review",
      reviewId,
      {
        summary: cmd.reason,
        review_id: reviewId,
        reason: cmd.reason,
        client_message_id: cmd.client_message_id ?? null,
        receipt_id: cmd.receipt_id ?? null,
        original_hash: cmd.original_hash ?? null,
        received_hash: cmd.received_hash ?? null,
        payload: cmd.payload ?? null,
        opened_by: "system",
      },
      { occurredAt: at }
    );
    const result = this.commit([event], { at });
    result.review_required = true;
    result.review_id = reviewId;
    return result;
  }

  resolveReview(cmd) {
    const at = cmd.now ?? isoNow();
    if (!this.state.reviews.has(cmd.review_id)) throw new DomainError(`复核 ${cmd.review_id} 不存在`);
    const event = makeEvent(
      EVENT_TYPES.REVIEW_RESOLVED,
      "review",
      cmd.review_id,
      {
        summary: cmd.resolution ?? "保全复核关闭",
        review_id: cmd.review_id,
        resolution: cmd.resolution ?? "",
        resolved_by: cmd.resolved_by,
      },
      { occurredAt: at }
    );
    return this.commit([event], { at });
  }

  // ------------------------------------------------------------
  // 查询：从一次演出还原全部依据
  // ------------------------------------------------------------

  /** 还原一次演出：实际使用原件/替身、累计负荷、检查证据、批准人。 */
  getPerformance(bookingId) {
    const booking = this.requireBooking(bookingId);
    const object = this.state.objects.get(booking.object_id);
    const plan = this.state.plans.get(booking.plan_id);
    const usageVersion = booking.usage?.evidence?.inspection_version ?? null;
    const versionLoad = usageVersion ? object.usedByVersion.get(usageVersion) ?? zeroLoad() : null;
    const inspection = usageVersion
      ? object.inspections.find((i) => i.version === usageVersion) ?? null
      : null;
    return {
      booking_id: booking.booking_id,
      plan: plan ? { plan_id: plan.plan_id, name: plan.name, venue: plan.venue } : null,
      troupe_id: booking.troupe_id,
      window: { starts_at: booking.starts_at, ends_at: booking.ends_at },
      status: booking.status,
      requested_scheme: booking.scheme,
      estimated_load: booking.estimated_load,
      approvals: booking.decisions.map((d) => ({
        decision: d.decision,
        approver: d.decided_by,
        decided_at: d.decided_at,
        components: d.components,
        substitutes: d.substitute_ids,
        inspection_version: d.inspection_version,
        quota_at_decision: d.quota_at_decision,
        observation_acknowledged: d.observation_acknowledged,
        note: d.note,
        evidence_event_id: d.event_id,
      })),
      suspensions: booking.suspensions,
      standby: booking.standby,
      reschedule_count: booking.reschedule_count ?? 0,
      actual: booking.usage
        ? {
            recorded_mode: booking.usage.recorded_mode,
            actual_components: booking.usage.actual_components,
            actual_substitutes: booking.usage.actual_substitutes,
            actual_load: booking.usage.actual_load,
            used_at: booking.usage.used_at,
            receipt_id: booking.usage.receipt_id,
          }
        : null,
      adjustments: booking.adjustments ?? [],
      inspection_evidence: inspection
        ? {
            version: inspection.version,
            inspected_at: inspection.inspected_at,
            inspector_id: inspection.inspector_id,
            vulnerability_level: inspection.vulnerability_level,
            vulnerabilities: inspection.vulnerabilities,
            quota: inspection.quota,
            kind: inspection.kind,
            repair_id: inspection.repair_id,
            recorded_event_id: inspection.event_id,
            evidence_refs: booking.usage?.evidence?.references ?? [],
          }
        : null,
      cumulative_load_on_version: versionLoad,
    };
  }

  /** 古件护照：材料脆弱项、检查版本、各版本已用/额度、状态、观察期、部件占用。 */
  getPassport(objectId, at = isoNow()) {
    const object = this.requireObject(objectId);
    const current = object.inspections.find((i) => i.version === object.currentVersion);
    const versions = object.inspections.map((inspection) => ({
      version: inspection.version,
      kind: inspection.kind,
      inspected_at: inspection.inspected_at,
      inspector_id: inspection.inspector_id,
      vulnerability_level: inspection.vulnerability_level,
      vulnerabilities: inspection.vulnerabilities,
      quota: inspection.quota,
      used: object.usedByVersion.get(inspection.version) ?? zeroLoad(),
      repair_id: inspection.repair_id,
    }));
    const upcoming = [...this.state.bookings.values()]
      .filter(
        (b) =>
          b.object_id === objectId &&
          ["confirmed", "suspended", "reconfirm_required"].includes(b.status) &&
          new Date(b.ends_at).getTime() > new Date(at).getTime()
      )
      .map((b) => ({
        booking_id: b.booking_id,
        plan_id: b.plan_id,
        troupe_id: b.troupe_id,
        status: b.status,
        starts_at: b.starts_at,
        ends_at: b.ends_at,
      }))
      .sort((a, b2) => new Date(a.starts_at) - new Date(b2.starts_at));
    return {
      object_id: object.object_id,
      name: object.name,
      status: object.status,
      current_version: object.currentVersion,
      effective_quota: this.effectiveQuota(object, at),
      used_on_current_version: usedOnCurrentVersion(object),
      observation: object.observationUntil
        ? { until: object.observationUntil, active: inObservation(object, at) }
        : null,
      current_vulnerabilities: current?.vulnerabilities ?? [],
      inspection_versions: versions,
      open_incidents: object.incidentIds
        .map((id) => this.state.incidents.get(id))
        .filter((i) => i && i.status === "open"),
      component_registry: [...state_entries(this.state.components)]
        .filter(([, c]) => c.owner_id === objectId)
        .map(([part_id, c]) => {
          const windows = this.state.locks.get(part_id);
          return { part_id, kind: c.kind, locks: windows ?? [] };
        }),
      upcoming_bookings: upcoming,
    };
  }

  pendingNotifications() {
    return this.state.notifications.filter((n) => n.delivery_status === "pending");
  }

  // ------------------------------------------------------------
  // 内部辅助
  // ------------------------------------------------------------

  commit(events, { clientMessageId, content, at } = {}) {
    const stamped = this.store.appendBatch(events, {
      getNextVersion: (type, id) => nextVersion(this.state, type, id),
    });
    this.reload();
    return { events: stamped, committed_at: at ?? isoNow(), client_message_id: clientMessageId ?? null };
  }

  effectiveQuota(object, at) {
    const inspection = object.inspections.find((i) => i.version === object.currentVersion);
    const base = inspection?.quota ?? quotaForLevel(inspection?.vulnerability_level ?? 1);
    if (inObservation(object, at)) {
      const capped = {};
      for (const dim of LOAD_DIMENSIONS) {
        capped[dim] = Math.round(base[dim] * OBSERVATION_QUOTA_RATIO * 10) / 10;
      }
      return capped;
    }
    return { ...base };
  }

  /** 同一古件在指定时间之前最近一场“已确认使用原件/局部”场次的结束时间。 */
  previousUsageEnd(objectId, startsAt, selfBookingId) {
    let candidate = null;
    for (const booking of this.state.bookings.values()) {
      if (booking.object_id !== objectId || booking.booking_id === selfBookingId) continue;
      if (["cancelled", "rejected"].includes(booking.status)) continue;
      if (new Date(booking.ends_at).getTime() >= new Date(startsAt).getTime()) continue;
      const decision = [...booking.decisions].reverse().find((d) => d.decision !== "rejected");
      if (decision && decision.decision === "substitute") continue;
      if (!candidate || new Date(booking.ends_at) > new Date(candidate)) candidate = booking.ends_at;
    }
    return candidate;
  }

  openIncidentParts(objectId) {
    const parts = new Set();
    for (const incident of this.state.incidents.values()) {
      if (incident.object_id === objectId && incident.status === "open") {
        for (const p of incident.part_ids ?? []) parts.add(p);
      }
    }
    return parts;
  }

  requireObject(id) {
    const object = this.state.objects.get(id);
    if (!object) throw new DomainError(`未知古件：${id}`);
    return object;
  }

  requirePlan(id) {
    const plan = this.state.plans.get(id);
    if (!plan) throw new DomainError(`未知场次：${id}`);
    return plan;
  }

  requireBooking(id) {
    const booking = this.state.bookings.get(id);
    if (!booking) throw new DomainError(`未知预约：${id}`);
    return booking;
  }

  requireRepair(id) {
    const repair = this.state.repairs.get(id);
    if (!repair) throw new DomainError(`未知修复方案：${id}`);
    return repair;
  }
}

function state_entries(map) {
  return Array.from(map.entries());
}

/** 重传比对时忽略传输层易变字段。 */
function stripTransient(cmd) {
  const { now, ...rest } = cmd;
  return rest;
}
