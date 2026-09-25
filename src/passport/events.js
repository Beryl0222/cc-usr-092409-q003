import { createHash } from "node:crypto";

/** 事件类型总表。前五项沿用既有约定，其余为演出负荷护照新增。 */
export const EVENT_TYPES = Object.freeze({
  OBJECT_INSPECTED: "OBJECT_INSPECTED", // 古件检查/复检（产生检查版本与额度）
  PERFORMANCE_PLANNED: "PERFORMANCE_PLANNED", // 演出/排练场次排定
  SUBSTITUTE_ASSIGNED: "SUBSTITUTE_ASSIGNED", // 复制替身或局部替换件登记
  REPAIR_RECORDED: "REPAIR_RECORDED", // 修复相关记录（兼容旧名）
  CLEARANCE_GRANTED: "CLEARANCE_GRANTED", // 操作许可（兼容旧名）

  BOOKING_REQUESTED: "BOOKING_REQUESTED", // 某剧团为场次申请使用某古件
  BOOKING_DECIDED: "BOOKING_DECIDED", // 保护员签认：原件/替身/局部替换/驳回
  BOOKING_RESCHEDULED: "BOOKING_RESCHEDULED", // 跨团改期
  BOOKING_SUSPENDED: "BOOKING_SUSPENDED", // 受异常影响暂停
  BOOKING_CANCELLED: "BOOKING_CANCELLED", // 取消并释放占用
  BOOKING_RECONFIRM_REQUIRED: "BOOKING_RECONFIRM_REQUIRED", // 新检查版本后须重新签认
  STANDBY_ASSIGNED: "STANDBY_ASSIGNED", // 候补替换分配
  USAGE_RECORDED: "USAGE_RECORDED", // 现场离线回执：实际使用与实际负荷
  INCIDENT_REPORTED: "INCIDENT_REPORTED", // 现场异常
  INCIDENT_RESOLVED: "INCIDENT_RESOLVED", // 异常随修复关闭
  REPAIR_PROPOSED: "REPAIR_PROPOSED",
  REPAIR_SIGNED: "REPAIR_SIGNED", // 双人签认之一
  REPAIR_COMPLETED: "REPAIR_COMPLETED", // 双人签认完成，激活复检版本
  NOTIFICATION_REQUESTED: "NOTIFICATION_REQUESTED",
  NOTIFICATION_DELIVERED: "NOTIFICATION_DELIVERED",
  REVIEW_OPENED: "REVIEW_OPENED", // 保全复核（如重传内容变化）
  REVIEW_RESOLVED: "REVIEW_RESOLVED",
});

export function contentHash(payload) {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

/** 统一构造事件信封。 */
export function makeEvent(type, aggregateType, aggregateId, payload, { occurredAt, extra } = {}) {
  return {
    event_type: type,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    occurred_at: occurredAt,
    summary: payload.summary ?? "",
    ...payload,
    ...(extra ?? {}),
  };
}
