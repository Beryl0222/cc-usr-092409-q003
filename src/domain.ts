/** 皮影古件演出保全使用的领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: DomainEventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  /** 按 aggregate_type/aggregate_id 独立递增。 */
  version: number;
  summary: string;
  /** 离线客户端消息编号；重传内容一致时不重复生效。 */
  client_message_id?: string;
  /** 消息内容 SHA-256，用于重传一致性比对。 */
  content_hash?: string;
}

export type DomainEventType =
  // 既有约定
  | "OBJECT_INSPECTED"
  | "PERFORMANCE_PLANNED"
  | "SUBSTITUTE_ASSIGNED"
  | "REPAIR_RECORDED"
  | "CLEARANCE_GRANTED"
  // 演出负荷护照
  | "BOOKING_REQUESTED"
  | "BOOKING_DECIDED"
  | "BOOKING_RESCHEDULED"
  | "BOOKING_SUSPENDED"
  | "BOOKING_CANCELLED"
  | "BOOKING_RECONFIRM_REQUIRED"
  | "STANDBY_ASSIGNED"
  | "USAGE_RECORDED"
  | "INCIDENT_REPORTED"
  | "INCIDENT_RESOLVED"
  | "REPAIR_PROPOSED"
  | "REPAIR_SIGNED"
  | "REPAIR_COMPLETED"
  | "NOTIFICATION_REQUESTED"
  | "NOTIFICATION_DELIVERED"
  | "REVIEW_OPENED"
  | "REVIEW_RESOLVED";

export type AggregateType =
  | "puppet_object"
  | "performance_plan"
  | "conservation_action"
  | "operator_clearance"
  | "booking"
  | "incident"
  | "substitute"
  | "notification"
  | "review";

/** 负荷四维度：强光 / 牵拉 / 运输 / 环境暴露，单位为点。 */
export interface Load {
  light: number;
  tension: number;
  transport: number;
  environment: number;
}

/** 材料脆弱项，绑定到可被多个方案引用的部件编号。 */
export interface Vulnerability {
  part_id: string;
  material?: string;
  note?: string;
}

/** 一次检查结论：版本、脆弱等级、脆弱项与该版本下的额度。 */
export interface Inspection {
  version: number;
  inspected_at: string;
  inspector_id: string;
  vulnerability_level: 1 | 2 | 3;
  vulnerabilities: Vulnerability[];
  component_ids?: string[];
  quota: Load;
  kind: "initial" | "routine" | "post_repair";
  repair_id?: string | null;
}

/** 保护员签认的使用方式。 */
export type BookingDecision = "original" | "substitute" | "partial" | "rejected";
