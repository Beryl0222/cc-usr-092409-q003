/** 皮影古件演出负荷护照使用的领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: DomainEventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  /** 各事件类型的业务负载；事件目录见 README 与 contracts/domain.schema.json。 */
  payload?: Record<string, unknown>;
}

/**
 * 基线保留：SUBSTITUTE_ASSIGNED / REPAIR_RECORDED / CLEARANCE_GRANTED。
 * 护照流程事件见下方其余成员。
 */
export type DomainEventType =
  | "OBJECT_INSPECTED"
  | "PERFORMANCE_PLANNED"
  | "PERFORMANCE_RESCHEDULED"
  | "STAGE_USE_CONFIRMED"
  | "STAGE_USE_CANCELLED"
  | "STAGE_COMPLETED"
  | "STANDBY_ACTIVATED"
  | "SUBSTITUTE_ASSIGNED"
  | "SUBSTITUTE_REGISTERED"
  | "DAMAGE_REPORTED"
  | "PERFORMANCE_PAUSED"
  | "PERFORMANCE_RESUMED"
  | "REPAIR_RECORDED"
  | "REPAIR_PLANNED"
  | "REPAIR_SIGN_RECORDED"
  | "RESTORATION_APPROVED"
  | "CLEARANCE_GRANTED"
  | "NOTIFICATION_QUEUED"
  | "NOTIFICATION_DELIVERED"
  | "NOTIFICATION_DELIVERY_FAILED"
  | "REVIEW_FLAGGED"
  | "REQUEST_RECORDED";

export type AggregateType =
  | "puppet_object"
  | "performance_plan"
  | "conservation_action"
  | "operator_clearance"
  | "substitute"
  | "notice_outbox"
  | "reconciliation";

/** 负荷三维：强光、牵拉、运输/环境暴露。 */
export type LoadDimension = "light" | "tension" | "transport";

/** 保护员对单个部件的使用方式：原件、复制替身、修复后复检的原件。 */
export type UseMode = "original" | "substitute" | "repair";
