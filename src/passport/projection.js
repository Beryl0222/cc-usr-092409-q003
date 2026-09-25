import { EVENT_TYPES } from "./events.js";
import { addLoad, zeroLoad } from "./load.js";
import { LOAD_DIMENSIONS, OBSERVATION_HOURS, quotaForLevel } from "./constants.js";

/**
 * 投影：把追加式事件日志折叠为当前读模型。
 * 进程重启后对完整日志重新 fold 一次即可恢复全部状态（观察期、候补、未完成通知均在事件里）。
 */
export function fold(events) {
  const state = {
    objects: new Map(),
    plans: new Map(),
    bookings: new Map(),
    /** partId -> { kind: "original"|"replica", owner_id } */
    components: new Map(),
    /** partId -> 当前有效独占占用时间窗列表（同部件不同时间窗可并存） */
    locks: new Map(),
    substitutes: new Map(),
    incidents: new Map(),
    repairs: new Map(),
    notifications: [],
    reviews: new Map(),
    /** client_message_id -> 首次处理凭证 */
    ledger: new Map(),
    /** receipt_id -> { client_message_id, event_ids, hash } */
    receipts: new Map(),
    /** aggregate_type/aggregate_id -> 已落盘事件数 */
    versions: new Map(),
    events,
  };

  for (const event of events) apply(state, event);
  return state;
}

export function nextVersion(state, aggregateType, aggregateId) {
  const key = `${aggregateType}/${aggregateId}`;
  return (state.versions.get(key) ?? 0) + 1;
}

function bumpVersion(state, event) {
  const key = `${event.aggregate_type}/${event.aggregate_id}`;
  state.versions.set(key, (state.versions.get(key) ?? 0) + 1);
}

function apply(state, event) {
  bumpVersion(state, event);
  // 幂等台账从事件本身重建：任何携带 client_message_id 的记录都登记首次凭证。
  if (event.client_message_id) {
    const entry = state.ledger.get(event.client_message_id);
    if (entry) {
      entry.event_ids.push(event.event_id);
    } else {
      state.ledger.set(event.client_message_id, {
        content_hash: event.content_hash ?? null,
        event_ids: [event.event_id],
        occurred_at: event.occurred_at,
      });
    }
  }
  switch (event.event_type) {
    case EVENT_TYPES.OBJECT_INSPECTED:
      return onInspected(state, event);
    case EVENT_TYPES.SUBSTITUTE_ASSIGNED:
      return onSubstituteAssigned(state, event);
    case EVENT_TYPES.PERFORMANCE_PLANNED:
      return onPlanned(state, event);
    case EVENT_TYPES.BOOKING_REQUESTED:
      return onRequested(state, event);
    case EVENT_TYPES.BOOKING_DECIDED:
      return onDecided(state, event);
    case EVENT_TYPES.BOOKING_RESCHEDULED:
      return onRescheduled(state, event);
    case EVENT_TYPES.BOOKING_SUSPENDED:
      return onSuspended(state, event);
    case EVENT_TYPES.BOOKING_CANCELLED:
      return onCancelled(state, event);
    case EVENT_TYPES.BOOKING_RECONFIRM_REQUIRED:
      return onReconfirm(state, event);
    case EVENT_TYPES.STANDBY_ASSIGNED:
      return onStandby(state, event);
    case EVENT_TYPES.USAGE_RECORDED:
      return onUsage(state, event);
    case EVENT_TYPES.INCIDENT_REPORTED:
      return onIncident(state, event);
    case EVENT_TYPES.INCIDENT_RESOLVED:
      return onIncidentResolved(state, event);
    case EVENT_TYPES.REPAIR_PROPOSED:
      return onRepairProposed(state, event);
    case EVENT_TYPES.REPAIR_SIGNED:
      return onRepairSigned(state, event);
    case EVENT_TYPES.REPAIR_COMPLETED:
      return onRepairCompleted(state, event);
    case EVENT_TYPES.NOTIFICATION_REQUESTED:
      return state.notifications.push({ ...event, delivery_status: "pending" });
    case EVENT_TYPES.NOTIFICATION_DELIVERED: {
      const note = [...state.notifications]
        .reverse()
        .find((n) => n.notification_id === event.notification_id);
      if (note) note.delivery_status = "delivered";
      return;
    }
    case EVENT_TYPES.REVIEW_OPENED:
      return state.reviews.set(event.review_id, { ...event, status: "open" });
    case EVENT_TYPES.REVIEW_RESOLVED: {
      const review = state.reviews.get(event.review_id);
      if (review) review.status = "resolved";
      return;
    }
    default:
      // 未知事件不阻断重放，保证旧版本日志可前向兼容。
      return;
  }
}

function onInspected(state, event) {
  let object = state.objects.get(event.object_id);
  if (!object) {
    object = {
      object_id: event.object_id,
      name: event.name ?? event.object_id,
      inspections: [],
      usedByVersion: new Map(),
      status: "active",
      incidentIds: [],
      repairIds: [],
      observationUntil: null,
    };
    state.objects.set(event.object_id, object);
  }
  if (event.name) object.name = event.name;
  const inspection = {
    version: event.inspection.version,
    inspected_at: event.inspection.inspected_at,
    inspector_id: event.inspection.inspector_id,
    vulnerability_level: event.inspection.vulnerability_level,
    vulnerabilities: event.inspection.vulnerabilities ?? [],
    quota: event.inspection.quota ?? quotaForLevel(event.inspection.vulnerability_level),
    kind: event.inspection.kind ?? (object.inspections.length ? "routine" : "initial"),
    repair_id: event.inspection.repair_id ?? null,
    event_id: event.event_id,
  };
  object.inspections.push(inspection);
  if (!object.usedByVersion.has(inspection.version)) {
    object.usedByVersion.set(inspection.version, zeroLoad());
  }
  object.currentVersion = inspection.version;
  // 登记/复检中声明的部件进入部件登记册。
  for (const v of inspection.vulnerabilities) {
    registerComponent(state, v.part_id, "original", event.object_id);
  }
  for (const partId of event.inspection.component_ids ?? []) {
    registerComponent(state, partId, "original", event.object_id);
  }
}

function onSubstituteAssigned(state, event) {
  state.substitutes.set(event.substitute_id, {
    substitute_id: event.substitute_id,
    scope: event.scope, // "whole" | "partial"
    object_id: event.object_id ?? null,
    part_ids: event.part_ids ?? [],
    note: event.note ?? "",
  });
  for (const partId of event.part_ids ?? []) {
    registerComponent(state, partId, "replica", event.substitute_id);
  }
}

function onPlanned(state, event) {
  state.plans.set(event.plan_id, {
    plan_id: event.plan_id,
    name: event.name,
    troupe_id: event.troupe_id,
    troupe_name: event.troupe_name ?? event.troupe_id,
    starts_at: event.starts_at,
    ends_at: event.ends_at,
    venue: event.venue ?? "",
  });
}

function onRequested(state, event) {
  state.bookings.set(event.booking_id, {
    booking_id: event.booking_id,
    plan_id: event.plan_id,
    troupe_id: event.troupe_id,
    object_id: event.object_id,
    requested_by: event.requested_by,
    status: "requested",
    scheme: event.scheme,
    starts_at: event.scheme.starts_at,
    ends_at: event.scheme.ends_at,
    estimated_load: event.estimated_load,
    inspection_version_at_request: event.at_inspection_version,
    decisions: [],
    suspensions: [],
    standby: null,
    usage: null,
  });
}

function onDecided(state, event) {
  const booking = state.bookings.get(event.booking_id);
  if (!booking) return;
  const decision = {
    decision: event.decision,
    decided_by: event.decided_by,
    decided_at: event.occurred_at,
    components: event.components_locked ?? [],
    substitute_ids: event.substitutes ?? [],
    estimated_load: event.estimated_load,
    inspection_version: event.inspection_version,
    quota_at_decision: event.quota_at_decision,
    observation_acknowledged: event.observation_acknowledged ?? false,
    note: event.note ?? "",
    event_id: event.event_id,
  };
  booking.decisions.push(decision);
  booking.plan_id = event.plan_id ?? booking.plan_id;
  booking.starts_at = event.starts_at ?? booking.starts_at;
  booking.ends_at = event.ends_at ?? booking.ends_at;
  if (event.scheme) booking.scheme = event.scheme;
  if (event.decision === "rejected") {
    booking.status = "rejected";
  } else {
    booking.status = "confirmed";
    relock(state, booking, decision.components);
  }
}

function onRescheduled(state, event) {
  const booking = state.bookings.get(event.booking_id);
  if (!booking) return;
  booking.plan_id = event.new_plan_id ?? booking.plan_id;
  booking.starts_at = event.new_starts_at;
  booking.ends_at = event.new_ends_at;
  if (event.new_scheme) booking.scheme = event.new_scheme;
  if (event.estimated_load) booking.estimated_load = event.estimated_load;
  const last = booking.decisions[booking.decisions.length - 1];
  if (last && booking.status === "confirmed") {
    relock(state, booking, last.components);
  }
  booking.reschedule_count = (booking.reschedule_count ?? 0) + 1;
}

function onSuspended(state, event) {
  const booking = state.bookings.get(event.booking_id);
  if (!booking) return;
  booking.status = "suspended";
  booking.suspensions.push({
    incident_id: event.incident_id,
    part_ids: event.part_ids ?? [],
    reason: event.reason,
    at: event.occurred_at,
  });
}

function onCancelled(state, event) {
  const booking = state.bookings.get(event.booking_id);
  if (!booking) return;
  booking.status = "cancelled";
  releaseLocks(state, booking.booking_id);
}

function onReconfirm(state, event) {
  const booking = state.bookings.get(event.booking_id);
  if (!booking) return;
  booking.status = "reconfirm_required";
  booking.reconfirm_reason = event.reason;
  // 旧检查版本下的签认不再有效，释放占用，等待保护员按新检查重新决定。
  releaseLocks(state, booking.booking_id);
}

function onStandby(state, event) {
  const booking = state.bookings.get(event.booking_id);
  if (!booking) return;
  booking.standby = {
    standby_type: event.standby_type,
    substitute_ids: event.substitute_ids ?? [],
    standby_object_id: event.standby_object_id ?? null,
    assigned_by: event.assigned_by,
    at: event.occurred_at,
  };
}

function onUsage(state, event) {
  const booking = state.bookings.get(event.booking_id);
  // 回执幂等：同编号重放不重复扣减。
  if (state.receipts.has(event.receipt_id)) return;
  state.receipts.set(event.receipt_id, {
    client_message_id: event.client_message_id,
    hash: event.content_hash,
    event_ids: [event.event_id],
    kind: event.kind ?? "actual",
  });

  if (booking && (event.kind ?? "actual") === "actual") {
    booking.status = "used";
    booking.usage = {
      receipt_id: event.receipt_id,
      recorded_mode: event.recorded_mode,
      actual_components: event.actual_components ?? [],
      actual_substitutes: event.actual_substitutes ?? [],
      actual_load: event.actual_load,
      used_at: event.used_at,
      evidence: event.evidence ?? {},
    };
    // 演出完成即释放部件占用，后续场次可继续引用。
    releaseLocks(state, booking.booking_id);
  } else if (booking && event.kind === "adjustment") {
    // 事后调整单不改变场次状态，只在实际负荷上叠加修正量，保留可追溯记录。
    booking.adjustments = [
      ...(booking.adjustments ?? []),
      { receipt_id: event.receipt_id, delta: event.actual_load, at: event.used_at },
    ];
  }

  const object = state.objects.get(event.object_id);
  if (object && event.recorded_mode !== "substitute") {
    const version = event.evidence?.inspection_version ?? object.currentVersion;
    const current = object.usedByVersion.get(version) ?? zeroLoad();
    object.usedByVersion.set(version, addLoad(current, event.actual_load));
  }
}

function onIncident(state, event) {
  state.incidents.set(event.incident_id, {
    incident_id: event.incident_id,
    object_id: event.object_id,
    part_ids: event.part_ids ?? [],
    scope: event.part_ids?.length ? "partial" : "whole",
    severity: event.severity,
    occurred_at: event.occurred_at,
    reported_by: event.reported_by,
    booking_id: event.booking_id ?? null,
    status: "open",
    repair_id: null,
  });
  const object = state.objects.get(event.object_id);
  if (object) {
    object.status = "incident";
    object.incidentIds.push(event.incident_id);
  }
}

function onIncidentResolved(state, event) {
  const incident = state.incidents.get(event.incident_id);
  if (!incident) return;
  incident.status = "resolved";
  incident.repair_id = event.repair_id ?? incident.repair_id;
  const object = state.objects.get(event.object_id);
  // 仅当该古件没有其他未关闭异常时才恢复正常状态。
  if (object && ![...state.incidents.values()].some(
    (i) => i.object_id === object.object_id && i.status === "open"
  )) {
    object.status = "active";
  }
}

function onRepairProposed(state, event) {
  state.repairs.set(event.repair_id, {
    repair_id: event.repair_id,
    object_id: event.object_id,
    incident_id: event.incident_id ?? null,
    part_ids: event.part_ids ?? [],
    proposed_by: event.proposed_by,
    proposed_at: event.occurred_at,
    plan: event.plan ?? "",
    target_level: event.target_inspection.vulnerability_level,
    target_vulnerabilities: event.target_inspection.vulnerabilities ?? [],
    signers: [],
    status: "proposed",
  });
}

function onRepairSigned(state, event) {
  const repair = state.repairs.get(event.repair_id);
  if (!repair) return;
  if (!repair.signers.some((s) => s.signer_id === event.signer_id)) {
    repair.signers.push({ signer_id: event.signer_id, role: event.role, signed_at: event.occurred_at });
  }
  // 状态机：proposed（0 人）→ awaiting_counter_sign（1 人）→ signed（2 人）→ completed（修复完成事件）。
  repair.status = repair.signers.length >= 2 ? "signed" : "awaiting_counter_sign";
}

function onRepairCompleted(state, event) {
  const repair = state.repairs.get(event.repair_id);
  if (repair) {
    repair.status = "completed";
    repair.completed_at = event.occurred_at;
    repair.observation_until = event.observation_until;
  }
  const object = state.objects.get(event.object_id);
  if (object) {
    object.observationUntil = event.observation_until;
    // 新检查版本与额度由同批次 OBJECT_INSPECTED 负责入账；历史用量仍保留在 usedByVersion 各版本下。
  }
}

function registerComponent(state, partId, kind, ownerId) {
  const existing = state.components.get(partId);
  if (existing && existing.owner_id !== ownerId) {
    throw new Error(`部件 ${partId} 已登记于 ${existing.owner_id}，不能重复登记`);
  }
  state.components.set(partId, { kind, owner_id: ownerId });
}

function releaseLocks(state, bookingId) {
  for (const [partId, windows] of state.locks) {
    const remaining = windows.filter((lock) => lock.booking_id !== bookingId);
    if (remaining.length) state.locks.set(partId, remaining);
    else state.locks.delete(partId);
  }
}

function relock(state, booking, components) {
  releaseLocks(state, booking.booking_id);
  for (const partId of components) {
    const windows = state.locks.get(partId) ?? [];
    windows.push({
      booking_id: booking.booking_id,
      starts_at: booking.starts_at,
      ends_at: booking.ends_at,
    });
    state.locks.set(partId, windows);
  }
}

/** 部件在指定时间窗内是否已被其他方案占用（原子占用：全部部件都须空闲）。 */
export function findComponentConflicts(state, partIds, startsAt, endsAt, selfBookingId) {
  const conflicts = [];
  for (const partId of partIds) {
    const windows = state.locks.get(partId) ?? [];
    const blocker = windows.find(
      (lock) => lock.booking_id !== selfBookingId && windowsOverlap(startsAt, endsAt, lock.starts_at, lock.ends_at)
    );
    if (blocker) conflicts.push({ part_id: partId, blocking_booking_id: blocker.booking_id });
  }
  return conflicts;
}

export function windowsOverlap(aStart, aEnd, bStart, bEnd) {
  return new Date(aStart) < new Date(bEnd) && new Date(bStart) < new Date(aEnd);
}

/** 当前检查周期内已用负荷。 */
export function usedOnCurrentVersion(object) {
  return object.usedByVersion.get(object.currentVersion) ?? zeroLoad();
}

/** 观察期判定。 */
export function inObservation(object, at) {
  return !!object.observationUntil && new Date(at) <= new Date(object.observationUntil);
}

export { OBSERVATION_HOURS, LOAD_DIMENSIONS };
