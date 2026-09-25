import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { PassportService, DomainError } from "../src/passport/service.js";
import { quotaForLevel } from "../src/passport/constants.js";
import { validateEvent } from "../src/validator.js";

let dir;

function newStore(name = "events.jsonl") {
  return new PassportService(join(dir, name));
}

const T0 = "2026-09-25T08:00:00Z";

function scheme(over = {}) {
  return {
    starts_at: "2026-09-26T10:00:00Z",
    ends_at: "2026-09-26T12:00:00Z",
    light_minutes: 20,
    tension_minutes: 15,
    environment_minutes: 40,
    transport_km: 5,
    transport_legs: 1,
    light_mode: "normal",
    part_ids: ["head", "arm", "body"],
    ...over,
  };
}

function seedObject(svc, over = {}) {
  svc.inspectObject({
    now: T0,
    object_id: "O1",
    name: "三国人物皮影",
    inspection: {
      inspector_id: "keeper-a",
      vulnerability_level: 2,
      component_ids: ["head", "arm", "body"],
      vulnerabilities: [{ part_id: "head", material: "驴皮", note: "强光下易褪色" }],
    },
    ...over,
  });
}

function seedPlan(svc, { planId = "P1", troupe = "troupe-A", start = "2026-09-26T10:00:00Z", end = "2026-09-26T12:00:00Z", name = "巡演场" } = {}) {
  svc.planPerformance({
    now: T0,
    plan_id: planId,
    name,
    troupe_id: troupe,
    starts_at: start,
    ends_at: end,
    venue: "流动戏台",
  });
}

function seedBooking(svc, { bookingId = "B1", planId = "P1", troupe = "troupe-A", s = scheme() } = {}) {
  svc.requestBooking({
    now: T0,
    booking_id: bookingId,
    plan_id: planId,
    troupe_id: troupe,
    object_id: "O1",
    requested_by: "stage-manager",
    scheme: s,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "passport-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------
// 1. 护照基础：检查版本、脆弱项与额度
// ------------------------------------------------------------

test("检查登记产生版本化额度，且额度随脆弱等级折算", () => {
  const svc = newStore();
  seedObject(svc);
  const pp = svc.getPassport("O1", T0);
  assert.equal(pp.current_version, 1);
  assert.deepEqual(pp.current_vulnerabilities[0].part_id, "head");
  assert.deepEqual(pp.effective_quota, quotaForLevel(2));
  // 等级 3 额度更低
  svc.inspectObject({
    now: T0, object_id: "O2",
    inspection: { inspector_id: "keeper-a", version: 1, vulnerability_level: 3, component_ids: [] },
  });
  assert.deepEqual(svc.getPassport("O2", T0).effective_quota, quotaForLevel(3));
  assert.ok(quotaForLevel(3).light < quotaForLevel(2).light);
});

test("排期先估算强光/牵拉/运输/环境消耗，再由保护员决定使用方式", () => {
  const svc = newStore();
  seedObject(svc);
  seedPlan(svc);
  const { assessment } = svc.requestBooking({
    now: T0, booking_id: "B1", plan_id: "P1", troupe_id: "troupe-A", object_id: "O1",
    requested_by: "sm", scheme: scheme(),
  });
  assert.ok(assessment.estimated_load.light > 0);
  assert.ok(assessment.estimated_load.transport > 0);
  assert.ok(assessment.estimated_load.environment > 0);
  assert.equal(assessment.within_quota, true);

  svc.decideBooking({ now: T0, booking_id: "B1", decision: "original", decided_by: "keeper-a" });
  const perf = svc.getPerformance("B1");
  assert.equal(perf.status, "confirmed");
  assert.equal(perf.approvals[0].decision, "original");
  assert.equal(perf.approvals[0].approver, "keeper-a");
});

test("整件复制替身不占用古件额度", () => {
  const svc = newStore();
  seedObject(svc);
  seedPlan(svc);
  svc.registerSubstitute({ now: T0, substitute_id: "SUB-W", scope: "whole", object_id: "O1" });
  seedBooking(svc);
  svc.decideBooking({ now: T0, booking_id: "B1", decision: "substitute", decided_by: "keeper-a", substitutes: ["SUB-W"] });
  svc.recordUsage({
    now: "2026-09-26T12:05:00Z", booking_id: "B1", receipt_id: "R1", client_message_id: "M1",
    recorded_mode: "substitute", actual_substitutes: ["SUB-W"],
    actual_load: { light: 999, tension: 999, transport: 999, environment: 999 },
  });
  const used = svc.getPassport("O1", "2026-09-26T13:00:00Z").used_on_current_version;
  assert.deepEqual(used, { light: 0, tension: 0, transport: 0, environment: 0 });
});

test("超出额度时原件签认被拒，可改用局部替换并只锁未替换部件", () => {
  const svc = newStore();
  seedObject(svc);
  seedPlan(svc);
  // 偏重方案：原件在强光/牵拉上超出等级 2 额度
  seedBooking(svc, { s: scheme({ light_minutes: 130, tension_minutes: 130 }) });
  assert.throws(
    () => svc.decideBooking({ now: T0, booking_id: "B1", decision: "original", decided_by: "keeper-a" }),
    (e) => e instanceof DomainError && e.code === "QUOTA_EXCEEDED"
  );
  // 局部替换：head 用替换件，只锁 arm/body；消耗按局部系数折算后回到额度内
  svc.registerSubstitute({ now: T0, substitute_id: "SUB-HEAD", scope: "partial", object_id: "O1", part_ids: ["head_rep"] });
  svc.decideBooking({
    now: T0, booking_id: "B1", decision: "partial", decided_by: "keeper-a",
    replaced_part_ids: ["head"], substitutes: ["SUB-HEAD"],
  });
  const locks = svc.getPassport("O1", T0).component_registry.filter((c) => c.locks.length);
  assert.deepEqual(locks.map((c) => c.part_id).sort(), ["arm", "body"]);
});

// ------------------------------------------------------------
// 2. 部件原子占用与跨团改期
// ------------------------------------------------------------

test("同一部件被两个剧团方案在重叠时间引用时，第二个方案整批失败", () => {
  const svc = newStore();
  seedObject(svc);
  seedPlan(svc, { planId: "PA", troupe: "troupe-A" });
  seedPlan(svc, { planId: "PB", troupe: "troupe-B", start: "2026-09-26T11:00:00Z", end: "2026-09-26T13:00:00Z" });
  seedBooking(svc, { bookingId: "BA", planId: "PA" });
  svc.decideBooking({ now: T0, booking_id: "BA", decision: "original", decided_by: "keeper-a" });
  seedBooking(svc, {
    bookingId: "BB", planId: "PB",
    s: scheme({ starts_at: "2026-09-26T11:00:00Z", ends_at: "2026-09-26T13:00:00Z" }),
  });
  assert.throws(
    () => svc.decideBooking({ now: T0, booking_id: "BB", decision: "original", decided_by: "keeper-a" }),
    (e) => e.code === "COMPONENT_CONFLICT" && e.conflicts.length === 3
  );
  // 失败后不得留下任何半占用：BB 仍未确认
  assert.equal(svc.getPerformance("BB").status, "requested");
});

test("跨团改期重放：冲突窗口原子失败且原占用保留；成功改期重算连续使用疲劳并迁移锁", () => {
  const svc = newStore();
  seedObject(svc);
  seedPlan(svc, { planId: "PA", troupe: "troupe-A" });
  seedPlan(svc, { planId: "PC", troupe: "troupe-C", start: "2026-09-26T20:00:00Z", end: "2026-09-26T22:00:00Z" });
  seedPlan(svc, { planId: "PB", troupe: "troupe-B", start: "2026-09-28T10:00:00Z", end: "2026-09-28T12:00:00Z" });
  seedBooking(svc, { bookingId: "BA", planId: "PA" });
  svc.decideBooking({ now: T0, booking_id: "BA", decision: "original", decided_by: "keeper-a" });
  seedBooking(svc, {
    bookingId: "BC", planId: "PC",
    s: scheme({ starts_at: "2026-09-26T20:00:00Z", ends_at: "2026-09-26T22:00:00Z" }),
  });
  svc.decideBooking({ now: T0, booking_id: "BC", decision: "original", decided_by: "keeper-a" });
  seedBooking(svc, {
    bookingId: "BB", planId: "PB",
    s: scheme({ starts_at: "2026-09-28T10:00:00Z", ends_at: "2026-09-28T12:00:00Z" }),
  });
  svc.decideBooking({ now: T0, booking_id: "BB", decision: "original", decided_by: "keeper-a" });

  const eventsBefore = countEvents(svc);
  // 改到与 C 团重叠的窗口：整体失败，日志不增加，BB 时间不变
  assert.throws(
    () => svc.rescheduleBooking({
      now: T0, booking_id: "BB", changed_by: "troupe-B",
      new_starts_at: "2026-09-26T20:30:00Z", new_ends_at: "2026-09-26T22:30:00Z",
    }),
    (e) => e.code === "COMPONENT_CONFLICT"
  );
  assert.equal(countEvents(svc), eventsBefore);
  assert.equal(svc.getPerformance("BB").window.starts_at, "2026-09-28T10:00:00Z");

  // 改到 22:30：与 C 场首尾相接不冲突，但距 C 场结束仅 0.5 小时 → 追加疲劳
  const res = svc.rescheduleBooking({
    now: T0, booking_id: "BB", changed_by: "troupe-B",
    new_starts_at: "2026-09-26T22:30:00Z", new_ends_at: "2026-09-27T00:30:00Z",
  });
  assert.ok(res.events[0].estimated_load._fatigue > 0);
  assert.equal(res.events[0].estimated_load._recoveryGapHours, 0.5);
  // 锁已迁移到新窗口：BB 占用新窗口，且既有不重叠占用（BA/BC）仍然保留
  const windows = svc.getPassport("O1", "2026-09-26T19:00:00Z")
    .component_registry
    .flatMap((c) => c.locks)
    .filter((lock) => lock.booking_id === "BB");
  assert.equal(windows.length, 3);
  assert.equal(windows[0].starts_at, "2026-09-26T22:30:00Z");
});

// ------------------------------------------------------------
// 3. 局部损伤与异常暂停范围
// ------------------------------------------------------------

test("现场局部异常只暂停涉损部件的后续场次；已完成演出保持当时依据，替身场次继续", () => {
  const svc = newStore();
  seedObject(svc);
  svc.registerSubstitute({ now: T0, substitute_id: "SUB-W", scope: "whole", object_id: "O1" });
  seedPlan(svc, { planId: "P1", troupe: "troupe-A" });
  seedPlan(svc, { planId: "P2", troupe: "troupe-B", start: "2026-09-28T10:00:00Z", end: "2026-09-28T12:00:00Z" });
  seedPlan(svc, { planId: "P3", troupe: "troupe-C", start: "2026-09-28T14:00:00Z", end: "2026-09-28T16:00:00Z" });

  seedBooking(svc, { bookingId: "B1", planId: "P1" });
  svc.decideBooking({ now: T0, booking_id: "B1", decision: "original", decided_by: "keeper-a" });
  svc.recordUsage({
    now: "2026-09-26T12:05:00Z", booking_id: "B1", receipt_id: "R1", client_message_id: "M1",
    recorded_mode: "original", actual_components: ["head", "arm", "body"],
    actual_load: { light: 20, tension: 15, transport: 20, environment: 25 },
  });
  seedBooking(svc, {
    bookingId: "B2", planId: "P2",
    s: scheme({ starts_at: "2026-09-28T10:00:00Z", ends_at: "2026-09-28T12:00:00Z" }),
  });
  svc.decideBooking({ now: T0, booking_id: "B2", decision: "original", decided_by: "keeper-a" });
  seedBooking(svc, {
    bookingId: "B3", planId: "P3",
    s: scheme({ starts_at: "2026-09-28T14:00:00Z", ends_at: "2026-09-28T16:00:00Z" }),
  });
  svc.decideBooking({ now: T0, booking_id: "B3", decision: "substitute", decided_by: "keeper-a", substitutes: ["SUB-W"] });

  svc.reportIncident({
    now: "2026-09-27T09:00:00Z", incident_id: "INC-1", object_id: "O1",
    part_ids: ["arm"], severity: "minor", reported_by: "stage-a", booking_id: "B1",
  });

  assert.equal(svc.getPerformance("B1").status, "used"); // 已完成，不动
  assert.equal(svc.getPerformance("B2").status, "suspended"); // 占用 arm → 暂停
  assert.equal(svc.getPerformance("B3").status, "confirmed"); // 替身场 → 继续
  // 已完成演出仍可还原当时批准人与检查依据
  const done = svc.getPerformance("B1");
  assert.equal(done.approvals[0].approver, "keeper-a");
  assert.equal(done.inspection_evidence.version, 1);
  assert.deepEqual(done.actual.actual_components, ["head", "arm", "body"]);

  // 暂停场可分配候补替换
  svc.assignStandby({
    now: "2026-09-27T09:30:00Z", booking_id: "B2",
    standby_type: "substitute", substitute_ids: ["SUB-W"], assigned_by: "keeper-a",
  });
  assert.equal(svc.getPerformance("B2").standby.standby_type, "substitute");
});

test("受损部件在修复前不能以原件方式再次签认", () => {
  const svc = newStore();
  seedObject(svc);
  seedPlan(svc, { planId: "P2", start: "2026-09-28T10:00:00Z", end: "2026-09-28T12:00:00Z" });
  svc.reportIncident({ now: "2026-09-27T08:00:00Z", incident_id: "INC-1", object_id: "O1", part_ids: ["arm"], reported_by: "s" });
  seedBooking(svc, {
    bookingId: "B2", planId: "P2",
    s: scheme({ starts_at: "2026-09-28T10:00:00Z", ends_at: "2026-09-28T12:00:00Z" }),
  });
  assert.throws(
    () => svc.decideBooking({ now: "2026-09-27T08:30:00Z", booking_id: "B2", decision: "original", decided_by: "keeper-a" }),
    /arm/
  );
});

// ------------------------------------------------------------
// 4. 修复：双人签认、观察期、额度恢复但不清空历史、复演重签
// ------------------------------------------------------------

test("修复方案双人签认后按新检查结果恢复额度，历史用量保留，并进入观察期", () => {
  const svc = newStore();
  seedObject(svc);
  seedPlan(svc);
  seedBooking(svc);
  svc.decideBooking({ now: T0, booking_id: "B1", decision: "original", decided_by: "keeper-a" });
  svc.recordUsage({
    now: "2026-09-26T12:05:00Z", booking_id: "B1", receipt_id: "R1", client_message_id: "M1",
    recorded_mode: "original", actual_components: ["head", "arm", "body"],
    actual_load: { light: 20, tension: 15, transport: 20, environment: 25 },
  });
  svc.reportIncident({ now: "2026-09-27T08:00:00Z", incident_id: "INC-1", object_id: "O1", part_ids: ["arm"], reported_by: "s" });

  svc.proposeRepair({
    now: "2026-09-27T09:00:00Z", repair_id: "RP-1", object_id: "O1", incident_id: "INC-1",
    part_ids: ["arm"], proposed_by: "cons-a", plan: "皮膜补缀并回软",
    target_inspection: { vulnerability_level: 1, vulnerabilities: [] },
  });
  // 单人签认不能完成
  svc.signRepair({ now: "2026-09-27T09:30:00Z", repair_id: "RP-1", signer_id: "cons-a", role: "lead" });
  assert.throws(
    () => svc.completeRepair({
      now: "2026-09-27T10:00:00Z", repair_id: "RP-1",
      inspection: { inspector_id: "keeper-a", vulnerability_level: 1, component_ids: ["head", "arm", "body"] },
    }),
    /双人签认/
  );
  // 同一人不能当第二签
  assert.throws(
    () => svc.signRepair({ now: "2026-09-27T09:35:00Z", repair_id: "RP-1", signer_id: "cons-a", role: "lead" }),
    /已签认/
  );
  svc.signRepair({ now: "2026-09-27T10:00:00Z", repair_id: "RP-1", signer_id: "cons-b", role: "reviewer" });
  svc.completeRepair({
    now: "2026-09-27T10:30:00Z", repair_id: "RP-1",
    inspection: { inspector_id: "keeper-a", vulnerability_level: 1, component_ids: ["head", "arm", "body"], vulnerabilities: [] },
  });

  const pp = svc.getPassport("O1", "2026-09-27T11:00:00Z");
  assert.equal(pp.current_version, 2);
  assert.equal(pp.observation.active, true);
  // 新版本按新检查结果给额度（等级 1），观察期内减半
  assert.equal(pp.effective_quota.light, quotaForLevel(1).light * 0.5);
  // 旧版本历史用量仍在
  const v1 = pp.inspection_versions.find((v) => v.version === 1);
  assert.deepEqual(v1.used, { light: 20, tension: 15, transport: 20, environment: 25 });
  const v2 = pp.inspection_versions.find((v) => v.version === 2);
  assert.deepEqual(v2.used, { light: 0, tension: 0, transport: 0, environment: 0 });
  assert.equal(v2.kind, "post_repair");
  assert.equal(v2.repair_id, "RP-1");
  // 异常已关闭
  assert.equal(pp.status, "active");
  assert.equal(pp.open_incidents.length, 0);
});

test("修复复演：未完成场次须按新检查版本重新签认，观察期限制不得被排练绕过", () => {
  const svc = newStore();
  seedObject(svc);
  seedPlan(svc, { planId: "P2", start: "2026-09-29T10:00:00Z", end: "2026-09-29T12:00:00Z" });
  seedBooking(svc, {
    bookingId: "B2", planId: "P2",
    s: scheme({ starts_at: "2026-09-29T10:00:00Z", ends_at: "2026-09-29T12:00:00Z" }),
  });
  svc.decideBooking({ now: T0, booking_id: "B2", decision: "original", decided_by: "keeper-a" });
  svc.reportIncident({ now: "2026-09-27T08:00:00Z", incident_id: "INC-1", object_id: "O1", part_ids: ["arm"], reported_by: "s" });
  svc.proposeRepair({
    now: "2026-09-27T09:00:00Z", repair_id: "RP-1", object_id: "O1", incident_id: "INC-1", part_ids: ["arm"],
    proposed_by: "cons-a", target_inspection: { vulnerability_level: 2, vulnerabilities: [] },
  });
  svc.signRepair({ now: "2026-09-27T09:30:00Z", repair_id: "RP-1", signer_id: "cons-a", role: "lead" });
  svc.signRepair({ now: "2026-09-27T10:00:00Z", repair_id: "RP-1", signer_id: "cons-b", role: "reviewer" });
  svc.completeRepair({
    now: "2026-09-27T10:30:00Z", repair_id: "RP-1",
    inspection: { inspector_id: "keeper-a", vulnerability_level: 2, component_ids: ["head", "arm", "body"] },
  });

  assert.equal(svc.getPerformance("B2").status, "reconfirm_required");
  // 观察期内不确认观察限制直接签原件 → 拒绝（即便以排练名义）
  assert.throws(
    () => svc.decideBooking({
      now: "2026-09-27T11:00:00Z", booking_id: "B2", decision: "original", decided_by: "keeper-a",
      new_scheme: { light_mode: "rehearsal" },
    }),
    /观察期/
  );
  // 明确确认观察期限制后可复演
  svc.decideBooking({
    now: "2026-09-27T11:00:00Z", booking_id: "B2", decision: "original",
    decided_by: "keeper-a", observation_acknowledged: true,
  });
  assert.equal(svc.getPerformance("B2").status, "confirmed");
  assert.equal(svc.getPerformance("B2").approvals.at(-1).observation_acknowledged, true);
});

// ------------------------------------------------------------
// 5. 离线回执：幂等与保全复核
// ------------------------------------------------------------

const receipt = (over = {}) => ({
  now: "2026-09-26T12:05:00Z",
  booking_id: "B1",
  receipt_id: "R1",
  client_message_id: "M1",
  recorded_mode: "original",
  actual_components: ["head", "arm", "body"],
  actual_load: { light: 20, tension: 15, transport: 20, environment: 25 },
  ...over,
});

test("同编号回执重传不重复扣减负荷", () => {
  const svc = newStore();
  seedObject(svc);
  seedPlan(svc);
  seedBooking(svc);
  svc.decideBooking({ now: T0, booking_id: "B1", decision: "original", decided_by: "keeper-a" });
  svc.recordUsage(receipt());
  const usedOnce = JSON.stringify(svc.getPassport("O1", "2026-09-26T13:00:00Z").used_on_current_version);
  // 离线后重传：now 不同属传输层易变字段，内容视为一致
  const again = svc.recordUsage(receipt({ now: "2026-09-28T00:00:00Z" }));
  assert.equal(again.duplicate, true);
  const third = svc.recordUsage(receipt({ now: "2026-09-28T01:00:00Z" }));
  assert.equal(third.duplicate, true);
  assert.equal(JSON.stringify(svc.getPassport("O1", "2026-09-28T02:00:00Z").used_on_current_version), usedOnce);
});

test("同编号但负荷内容变化：不扣减，进入保全复核", () => {
  const svc = newStore();
  seedObject(svc);
  seedPlan(svc);
  seedBooking(svc);
  svc.decideBooking({ now: T0, booking_id: "B1", decision: "original", decided_by: "keeper-a" });
  svc.recordUsage(receipt());
  const before = JSON.stringify(svc.getPassport("O1", "2026-09-26T13:00:00Z").used_on_current_version);
  const changed = svc.recordUsage(receipt({ actual_load: { light: 88, tension: 15, transport: 20, environment: 25 } }));
  assert.equal(changed.review_required, true);
  assert.ok(changed.review_id);
  assert.equal(JSON.stringify(svc.getPassport("O1", "2026-09-26T13:00:00Z").used_on_current_version), before);
});

test("现场读数缺失维度回退到排期估算值", () => {  const svc = newStore();
  seedObject(svc);
  seedPlan(svc);
  const { assessment } = svc.requestBooking({
    now: T0, booking_id: "B1", plan_id: "P1", troupe_id: "troupe-A", object_id: "O1",
    requested_by: "sm", scheme: scheme(),
  });
  svc.decideBooking({ now: T0, booking_id: "B1", decision: "original", decided_by: "keeper-a" });
  svc.recordUsage(receipt({ actual_load: { light: 10 } }));
  const actual = svc.getPerformance("B1").actual.actual_load;
  assert.equal(actual.light, 10);
  assert.equal(actual.tension, assessment.estimated_load.tension);
  assert.equal(actual.transport, assessment.estimated_load.transport);
});

test("同编号回执编号复用于不同消息时不扣减并进入保全复核；事后调整单可叠加修正量", () => {
  const svc = newStore();
  seedObject(svc);
  seedPlan(svc);
  seedBooking(svc);
  svc.decideBooking({ now: T0, booking_id: "B1", decision: "original", decided_by: "keeper-a" });
  svc.recordUsage(receipt());
  // 不同消息编号却复用同一 receipt_id → 复核，不扣减
  const reused = svc.recordUsage(receipt({ client_message_id: "M2" }));
  assert.equal(reused.review_required, true);

  // 事后调整单（如补测发现运输读数少计）：在已完成场次上叠加修正增量
  const before = svc.getPerformance("B1").actual.actual_load.transport;
  svc.recordUsage(receipt({
    client_message_id: "M3", receipt_id: "R2", kind: "adjustment",
    actual_load: { light: 0, tension: 0, transport: 4, environment: 0 },
  }));
  const perf = svc.getPerformance("B1");
  assert.equal(perf.status, "used");
  assert.equal(perf.adjustments?.length ?? 0, 1);
  const pp = svc.getPassport("O1", "2026-09-26T13:00:00Z");
  assert.equal(pp.used_on_current_version.transport, before + 4);
});

// ------------------------------------------------------------
// 6. 服务重启后续跑
// ------------------------------------------------------------

test("重启后继续观察期、候补替换、未完成通知，且重传仍幂等", () => {
  const file = join(dir, "persist.jsonl");
  let svc = new PassportService(file);
  seedObject(svc);
  seedPlan(svc, { planId: "P2", start: "2026-09-29T10:00:00Z", end: "2026-09-29T12:00:00Z" });
  seedBooking(svc, {
    bookingId: "B2", planId: "P2",
    s: scheme({ starts_at: "2026-09-29T10:00:00Z", ends_at: "2026-09-29T12:00:00Z" }),
  });
  svc.decideBooking({ now: T0, booking_id: "B2", decision: "original", decided_by: "keeper-a" });
  svc.reportIncident({ now: "2026-09-27T08:00:00Z", incident_id: "INC-1", object_id: "O1", part_ids: ["arm"], reported_by: "s" });
  svc.assignStandby({
    now: "2026-09-27T08:30:00Z", booking_id: "B2",
    standby_type: "substitute", substitute_ids: ["SUB-W"], assigned_by: "keeper-a",
  });
  svc.proposeRepair({
    now: "2026-09-27T09:00:00Z", repair_id: "RP-1", object_id: "O1", incident_id: "INC-1", part_ids: ["arm"],
    proposed_by: "cons-a", target_inspection: { vulnerability_level: 2, vulnerabilities: [] },
  });
  svc.signRepair({ now: "2026-09-27T09:30:00Z", repair_id: "RP-1", signer_id: "cons-a", role: "lead" });
  svc.signRepair({ now: "2026-09-27T10:00:00Z", repair_id: "RP-1", signer_id: "cons-b", role: "reviewer" });
  svc.completeRepair({
    now: "2026-09-27T10:30:00Z", repair_id: "RP-1",
    inspection: { inspector_id: "keeper-a", vulnerability_level: 2, component_ids: ["head", "arm", "body"] },
  });
  const pendingBefore = svc.pendingNotifications().map((n) => n.notification_id).sort();

  // 模拟进程重启：用同一日志文件重新构造服务
  const restarted = new PassportService(file);
  const pp = restarted.getPassport("O1", "2026-09-27T11:00:00Z");
  assert.equal(pp.observation.active, true); // 观察期继续
  assert.equal(restarted.getPerformance("B2").standby.standby_type, "substitute"); // 候补仍在
  assert.equal(restarted.getPerformance("B2").status, "reconfirm_required");
  assert.deepEqual(restarted.pendingNotifications().map((n) => n.notification_id).sort(), pendingBefore);

  // 重启后投递一条待发通知，幂等投递
  const noteId = pendingBefore[0];
  restarted.deliverNotification({ now: "2026-09-27T11:05:00Z", notification_id: noteId, delivered_to: "troupe-B" });
  const dup = restarted.deliverNotification({ now: "2026-09-27T11:06:00Z", notification_id: noteId, delivered_to: "troupe-B" });
  assert.equal(dup.duplicate, true);

  // 重启后新事件的聚合版本继续递增（B2 此前已有 5 个事件）
  const redecide = restarted.decideBooking({
    now: "2026-09-27T11:10:00Z", booking_id: "B2", decision: "original",
    decided_by: "keeper-a", observation_acknowledged: true,
  });
  assert.equal(redecide.events[0].version, 6);
});

// ------------------------------------------------------------
// 7. 一次演出的完整还原
// ------------------------------------------------------------

test("从一次演出还原实际使用原件/替身、累计负荷、检查证据与批准人", () => {
  const svc = newStore();
  seedObject(svc);
  svc.registerSubstitute({ now: T0, substitute_id: "SUB-HEAD", scope: "partial", object_id: "O1", part_ids: ["head_rep"] });
  seedPlan(svc);
  seedBooking(svc, { s: scheme({ replaced_part_ids: ["head"] }) });
  svc.decideBooking({
    now: T0, booking_id: "B1", decision: "partial", decided_by: "keeper-a",
    replaced_part_ids: ["head"], substitutes: ["SUB-HEAD"],
  });
  svc.recordUsage({
    now: "2026-09-26T12:05:00Z", booking_id: "B1", receipt_id: "R1", client_message_id: "M1",
    recorded_mode: "partial", actual_components: ["arm", "body"], actual_substitutes: ["SUB-HEAD"],
    actual_load: { light: 12, tension: 9, transport: 16, environment: 18 },
    evidence_refs: ["photo-001", "light-log-001"], evidence_note: "现场记录见随附照片",
    recorded_by: "stage-a",
  });
  const perf = svc.getPerformance("B1");
  assert.equal(perf.actual.recorded_mode, "partial");
  assert.deepEqual(perf.actual.actual_components, ["arm", "body"]);
  assert.deepEqual(perf.actual.actual_substitutes, ["SUB-HEAD"]);
  assert.deepEqual(perf.actual.actual_load, { light: 12, tension: 9, transport: 16, environment: 18 });
  assert.deepEqual(perf.cumulative_load_on_version, { light: 12, tension: 9, transport: 16, environment: 18 });
  assert.equal(perf.inspection_evidence.version, 1);
  assert.equal(perf.inspection_evidence.inspector_id, "keeper-a");
  assert.equal(perf.inspection_evidence.vulnerability_level, 2);
  assert.deepEqual(perf.inspection_evidence.evidence_refs, ["photo-001", "light-log-001"]);
  assert.equal(perf.approvals.at(-1).approver, "keeper-a");
  assert.equal(perf.approvals.at(-1).decision, "partial");
  assert.ok(perf.approvals.at(-1).evidence_event_id);
});

// ------------------------------------------------------------
// 8. 事件信封仍符合基础约定，且版本按聚合递增
// ------------------------------------------------------------

test("护照事件满足基础信封校验，版本按各自聚合独立递增", () => {
  const svc = newStore();
  seedObject(svc); // puppet_object/O1 v1
  seedPlan(svc); // performance_plan/P1 v1
  seedBooking(svc); // booking/B1 v1
  svc.decideBooking({ now: T0, booking_id: "B1", decision: "original", decided_by: "keeper-a" }); // booking/B1 v2
  const lines = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  for (const event of lines) assert.deepEqual(validateEvent(event), []);
  const byAgg = {};
  for (const event of lines) {
    const key = `${event.aggregate_type}/${event.aggregate_id}`;
    byAgg[key] ??= [];
    byAgg[key].push(event.version);
  }
  assert.deepEqual(byAgg["puppet_object/O1"], [1]);
  assert.deepEqual(byAgg["performance_plan/P1"], [1]);
  assert.deepEqual(byAgg["booking/B1"], [1, 2]);
});

function countEvents(svc) {
  return svc.state.events.length;
}
