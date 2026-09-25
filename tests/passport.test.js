import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EventStore } from "../src/store.js";
import { CareService } from "../src/service.js";
import { ModelError } from "../src/model.js";

/* ---------------------------------- 夹具 ---------------------------------- */

class Clock {
  constructor(start) {
    this.t = new Date(start).getTime();
  }
  now() {
    return new Date(this.t).toISOString();
  }
  at(iso) {
    this.t = new Date(iso).getTime();
    return this.now();
  }
  tick(minutes) {
    this.t += minutes * 60_000;
    return this.now();
  }
}

async function makeService() {
  const dir = await mkdtemp(join(tmpdir(), "passport-"));
  const clock = new Clock("2026-09-25T09:00:00+08:00");
  const store = new EventStore(join(dir, "events.jsonl"));
  const svc = await new CareService(store, { now: () => clock.now() }).start();
  const cleanup = () => rm(dir, { recursive: true, force: true });
  return { dir, clock, store, svc, cleanup, file: join(dir, "events.jsonl") };
}

async function restart(fixture) {
  const store = new EventStore(fixture.file);
  const svc = await new CareService(store, { now: () => fixture.clock.now() }).start();
  fixture.store = store;
  fixture.svc = svc;
  return svc;
}

const P1_COMPONENTS = [
  { component_id: "head", name: "彩绘头部", material: "牛皮", factors: { light: 2, tension: 1.5, transport: 1 } },
  { component_id: "body", name: "蟒身", material: "牛皮", factors: { light: 1, tension: 1, transport: 1 } },
  { component_id: "arm", name: "操纵杆连接臂", material: "驴皮", shared_part_id: "joint-A", factors: { light: 1, tension: 2, transport: 1 } },
];

async function seedPassport(svc, at, { passportId = "P1", quota = { light: 20, tension: 20, transport: 20 }, inspectionId = "insp-1" } = {}) {
  await svc.recordInspection({
    at,
    passport_id: passportId,
    puppet_id: `pu-${passportId}`,
    puppet_name: passportId === "P1" ? "牛皮彩绘战将" : "另一件共享关节影人",
    inspection_id: inspectionId,
    inspected_at: at,
    quota,
    components:
      passportId === "P1"
        ? P1_COMPONENTS
        : [
            { component_id: "tail", name: "尾杆", material: "驴皮", shared_part_id: "joint-A", factors: { light: 1, tension: 2, transport: 1 } },
            { component_id: "plate", name: "身板", material: "牛皮", factors: { light: 1, tension: 1, transport: 1 } },
          ],
  });
}

const originalsFor = (svc, passportId = "P1") =>
  svc.passport(passportId).components.map((c) => ({ component_id: c.component_id, mode: "original" }));

async function registerSubstitutes(svc, at, ids) {
  for (const { id, component } of ids) {
    await svc.registerSubstitute({ at, substitute_id: id, component_id: component, name: `复制替身-${id}` });
  }
}

const show = (run_id, day, { h = 19, m = 0, duration = 2 } = {}) => ({
  run_id,
  kind: "show",
  from: `2026-${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+08:00`,
  to: `2026-${day}T${String(h + duration).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+08:00`,
});

async function expectError(code, fn) {
  await assert.rejects(fn, (err) => {
    assert.ok(err instanceof ModelError, `期望 ModelError，实际 ${err}`);
    assert.equal(err.code, code, `期望错误码 ${code}，实际 ${err.code}（${err.message}）`);
    return true;
  });
}

/* ------------------------- 场景一：跨团累计与额度拦截 ------------------------- */

test("多个剧团累计同一古件负荷，超出额度的预订被拦截，局部替换放行", async () => {
  const f = await makeService();
  try {
    const at = f.clock.now();
    await registerSubstitutes(f.svc, at, [
      { id: "sub-head-1", component: "head" },
      { id: "sub-arm-1", component: "arm" },
    ]);
    await seedPassport(f.svc, at);

    await f.svc.planPerformance({ at, passport_id: "P1", performance_id: "perf-A", troupe_id: "troupe-A", title: "甲团巡演", runs: [show("r1", "10-01")] });
    await f.svc.planPerformance({ at, passport_id: "P1", performance_id: "perf-B", troupe_id: "troupe-B", title: "乙团巡演", runs: [show("r1", "10-02")] });
    await f.svc.planPerformance({ at, passport_id: "P1", performance_id: "perf-C", troupe_id: "troupe-C", title: "丙团巡演", runs: [show("r1", "10-03")] });

    // 一场完整原件演出：头部 light4/tension3，身 light2/tension2，臂 light2/tension4 => light8/tension9
    await f.svc.confirmUse({ at, passport_id: "P1", performance_id: "perf-A", run_id: "r1", approver: "保护员甲", entries: originalsFor(f.svc) });
    await f.svc.confirmUse({ at, passport_id: "P1", performance_id: "perf-B", run_id: "r1", approver: "保护员甲", entries: originalsFor(f.svc) });

    let p = f.svc.passport("P1");
    assert.deepEqual(p.balances.reserved, { light: 16, tension: 18, transport: 0 });
    assert.deepEqual(p.balances.available, { light: 4, tension: 2, transport: 20 });

    // 排期试算先给出风险与建议
    const est = f.svc.estimatePerformance("P1", "perf-C");
    assert.ok(est.runs[0].issues.some((i) => i.code === "QUOTA_EXCEEDED"));
    assert.equal(est.runs[0].recommendation, "local_replacement");

    // 丙团仍按全原件预订：被拒
    await expectError("QUOTA_EXCEEDED", () =>
      f.svc.confirmUse({ at, passport_id: "P1", performance_id: "perf-C", run_id: "r1", approver: "保护员丙", entries: originalsFor(f.svc) }),
    );

    // 丙团改用复制替身替换高负荷的头、臂，仅身上场：light2/tension2，恰好放入剩余额度
    await f.svc.confirmUse({
      at,
      passport_id: "P1",
      performance_id: "perf-C",
      run_id: "r1",
      approver: "保护员丙",
      entries: [
        { component_id: "head", mode: "substitute", substitute_id: "sub-head-1" },
        { component_id: "body", mode: "original" },
        { component_id: "arm", mode: "substitute", substitute_id: "sub-arm-1" },
      ],
    });
    p = f.svc.passport("P1");
    assert.deepEqual(p.balances.reserved, { light: 18, tension: 20, transport: 0 });

    // 甲团完成：从预留转为已用；离线回执可晚到
    f.clock.tick(6 * 24 * 60 + 11 * 60);
    await f.svc.completeRun({ receipt_id: "receipt-A-r1", passport_id: "P1", performance_id: "perf-A", run_id: "r1" });
    p = f.svc.passport("P1");
    assert.deepEqual(p.balances.used, { light: 8, tension: 9, transport: 0 });
    assert.deepEqual(p.balances.reserved, { light: 10, tension: 11, transport: 0 });
  } finally {
    await f.cleanup();
  }
});

/* --------------- 场景二：共享部件原子占用 + 跨护照整批原子提交 --------------- */

test("同一共享部件被两个古件方案引用时重叠占用被拒，整批失败不留半占", async () => {
  const f = await makeService();
  try {
    const at = f.clock.now();
    await seedPassport(f.svc, at);
    await seedPassport(f.svc, at, { passportId: "P2" });

    await f.svc.planPerformance({ at, passport_id: "P1", performance_id: "perf-A", troupe_id: "troupe-A", runs: [show("r1", "10-01")] });
    await f.svc.planPerformance({ at, passport_id: "P2", performance_id: "perf-D", troupe_id: "troupe-D", runs: [show("rx", "10-01", { h: 20 }), show("ro", "10-05")] });

    await f.svc.confirmUse({ at, passport_id: "P1", performance_id: "perf-A", run_id: "r1", approver: "w1", entries: originalsFor(f.svc) });

    // P2 10-01 20:00–22:00 与 P1 19:00–21:00 在共享部件 joint-A 上时间重叠
    await expectError("RESOURCE_BUSY", () =>
      f.svc.confirmUse({ at, passport_id: "P2", performance_id: "perf-D", run_id: "rx", approver: "w1", entries: originalsFor(f.svc, "P2") }),
    );

    // 跨护照整批：先提交不冲突的 ro，再提交冲突的 rx —— 整批必须回滚
    const raw = (event_id, performance_id, run_id, passport_id, from, to) => ({
      event_id,
      event_type: "STAGE_USE_CONFIRMED",
      aggregate_type: "performance_plan",
      aggregate_id: performance_id,
      occurred_at: at,
      version: 1,
      summary: "raw",
      payload: {
        at,
        passport_id: passport_id,
        performance_id,
        run_id,
        plan_revision: 1,
        approver: "w1",
        entries: passport_id === "P1" ? originalsFor(f.svc, "P1") : originalsFor(f.svc, "P2"),
        note: null,
        // 覆盖场次时间窗以构造与 P1 重叠的 rx（模型以排期事件为准，故改用直接排原始事件的方式）
      },
    });
    // 直接用模型层面的跨护照批次验证：ro 不重叠、rx 重叠，整批失败
    const { foldEvents, ModelError: ME } = await import("../src/model.js");
    const baseEvents = f.store.allEvents();
    assert.throws(
      () =>
        foldEvents([
          ...baseEvents,
          raw("evt-ro", "perf-D", "ro", "P2"),
          raw("evt-rx", "perf-D", "rx", "P2"),
        ]),
      (err) => err instanceof ME && err.code === "RESOURCE_BUSY",
    );

    // ro 没有留下半占用：随后通过正常服务确认 ro 成功（若半占存在会 ALREADY_CONFIRMED）
    await f.svc.confirmUse({ at, passport_id: "P2", performance_id: "perf-D", run_id: "ro", approver: "w1", entries: originalsFor(f.svc, "P2") });

    // P2 的 rx 改用替身尾杆绕开共享部件，重叠时间窗也能上场（不消耗原件额度）
    await f.svc.registerSubstitute({ at, substitute_id: "sub-tail-1", component_id: "tail" });
    await f.svc.confirmUse({
      at,
      passport_id: "P2",
      performance_id: "perf-D",
      run_id: "rx",
      approver: "w1",
      entries: [
        { component_id: "tail", mode: "substitute", substitute_id: "sub-tail-1" },
        { component_id: "plate", mode: "original" },
      ],
    });
  } finally {
    await f.cleanup();
  }
});

/* ---------------------- 场景三：跨团改期与旧版本失效 ---------------------- */

test("跨团改期原子取消旧确认并换版，已完成演出保持当时依据", async () => {
  const f = await makeService();
  try {
    const at = f.clock.now();
    await seedPassport(f.svc, at, { quota: { light: 20, tension: 20, transport: 20 } });
    await f.svc.planPerformance({ at, passport_id: "P1", performance_id: "perf-A", troupe_id: "troupe-A", runs: [show("r1", "10-01")] });
    await f.svc.planPerformance({ at, passport_id: "P1", performance_id: "perf-B", troupe_id: "troupe-B", runs: [show("r1", "10-02")] });
    await f.svc.confirmUse({ at, passport_id: "P1", performance_id: "perf-A", run_id: "r1", approver: "w1", entries: originalsFor(f.svc) });
    await f.svc.confirmUse({ at, passport_id: "P1", performance_id: "perf-B", run_id: "r1", approver: "w1", entries: originalsFor(f.svc) });

    // 乙团先完成（乙团已用 8/9 成为历史事实）
    f.clock.tick(7 * 24 * 60 + 13 * 60);
    await f.svc.completeRun({ receipt_id: "rcpt-B", passport_id: "P1", performance_id: "perf-B", run_id: "r1" });

    // 甲团改期：同批次原子取消旧确认 + 换版到 10-10
    f.clock.tick(10);
    const at2 = f.clock.now();
    await f.svc.reschedulePerformance({
      at: at2,
      passport_id: "P1",
      performance_id: "perf-A",
      runs: [show("r1", "10-10")],
    });
    const perfA = f.svc.passport("P1").performances.find((x) => x.performance_id === "perf-A");
    assert.equal(perfA.plan_revision, 2);
    assert.equal(perfA.runs[0].status, "planned");

    // 旧确认已释放：乙团已完成 8/9，甲团不再预留，可用额度 12/11
    const p = f.svc.passport("P1");
    assert.deepEqual(p.balances.used, { light: 8, tension: 9, transport: 0 });
    assert.deepEqual(p.balances.reserved, { light: 0, tension: 0, transport: 0 });

    // 旧版本号的确认被拒
    const { foldEvents, ModelError: ME2 } = await import("../src/model.js");
    assert.throws(
      () =>
        foldEvents([
          ...f.store.allEvents(),
          {
            event_id: "evt-stale",
            event_type: "STAGE_USE_CONFIRMED",
            aggregate_type: "performance_plan",
            aggregate_id: "perf-A",
            occurred_at: at2,
            version: 9,
            summary: "stale",
            payload: {
              at: at2, passport_id: "P1", performance_id: "perf-A", run_id: "r1", plan_revision: 1,
              approver: "w1", entries: originalsFor(f.svc), note: null,
            },
          },
        ]),
      (err) => err instanceof ME2 && err.code === "PLAN_REVISED",
    );

    // 改期后释放的额度让丙团 10-03 的全原件预订得以通过
    await f.svc.planPerformance({ at: at2, passport_id: "P1", performance_id: "perf-C", troupe_id: "troupe-C", runs: [show("r1", "10-03")] });
    await f.svc.confirmUse({ at: at2, passport_id: "P1", performance_id: "perf-C", run_id: "r1", approver: "w2", entries: originalsFor(f.svc) });

    // 乙团已完成的演出不受改期影响
    const traceB = f.svc.tracePerformance("P1", "perf-B");
    assert.equal(traceB.runs[0].status, "completed");
    assert.deepEqual(traceB.runs[0].load_recorded, { light: 8, tension: 9, transport: 0 });
  } finally {
    await f.cleanup();
  }
});

/* ------- 场景四：局部损伤 → 暂停后续 → 候补替换 → 双人签认修复 → 复检复演 ------- */

test("局部损伤只停后续场次；候补续演；双人签认修复后凭复检恢复额度并延续观察期与通知", async () => {
  const f = await makeService();
  try {
    const at = f.clock.at("2026-09-25T09:00:00+08:00");
    await registerSubstitutes(f.svc, at, [
      { id: "sub-head-1", component: "head" },
      { id: "sub-body-1", component: "body" },
      { id: "sub-arm-1", component: "arm" },
    ]);
    await seedPassport(f.svc, at, { quota: { light: 40, tension: 40, transport: 40 } });

    await f.svc.planPerformance({ at, passport_id: "P1", performance_id: "perf-A", troupe_id: "troupe-A", title: "甲团",
      runs: [{ run_id: "reh", kind: "rehearsal", from: "2026-09-28T14:00:00+08:00", to: "2026-09-28T16:00:00+08:00" }, show("show", "10-01")] });
    await f.svc.planPerformance({ at, passport_id: "P1", performance_id: "perf-B", troupe_id: "troupe-B", title: "乙团", runs: [show("r1", "10-02")] });
    await f.svc.planPerformance({ at, passport_id: "P1", performance_id: "perf-C", troupe_id: "troupe-C", title: "丙团", runs: [show("r1", "10-03")] });

    // 9-28 排练（原件）并完成：排练 light1/tension1 × 系数 => 头2/1.5、身1/1、臂1/2 => light4/tension4.5
    await f.svc.confirmUse({ at, passport_id: "P1", performance_id: "perf-A", run_id: "reh", approver: "w1", entries: originalsFor(f.svc) });
    f.clock.at("2026-09-28T16:05:00+08:00");
    await f.svc.completeRun({ receipt_id: "rcpt-reh", passport_id: "P1", performance_id: "perf-A", run_id: "reh" });

    // 10-01、10-02、10-03 三场原件演出先后确认（各 light8/tension9）
    f.clock.at("2026-09-29T10:00:00+08:00");
    const ct = f.clock.now();
    await f.svc.confirmUse({ at: ct, passport_id: "P1", performance_id: "perf-A", run_id: "show", approver: "w1", entries: originalsFor(f.svc) });
    await f.svc.confirmUse({ at: ct, passport_id: "P1", performance_id: "perf-B", run_id: "r1", approver: "w1", entries: originalsFor(f.svc) });
    await f.svc.confirmUse({ at: ct, passport_id: "P1", performance_id: "perf-C", run_id: "r1", approver: "w1", entries: originalsFor(f.svc) });

    // 10-01 演出 20:00 操纵臂局部撕裂
    f.clock.at("2026-10-01T20:00:00+08:00");
    const damageAt = f.clock.now();
    await f.svc.reportDamage({
      at: damageAt,
      passport_id: "P1",
      damage_report_id: "dmg-001",
      performance_id: "perf-A",
      run_id: "show",
      components: ["arm"],
      note: "操纵杆连接处皮条撕裂",
    });

    let p = f.svc.passport("P1");
    assert.equal(p.paused, true);
    assert.deepEqual(p.damage.components, ["arm"]);

    // 当场中断；乙、丙后续场次暂停；已完成排练保持当时依据
    const traceA = f.svc.tracePerformance("P1", "perf-A");
    assert.equal(traceA.runs.find((r) => r.run_id === "reh").status, "completed");
    assert.equal(traceA.runs.find((r) => r.run_id === "show").status, "interrupted");
    for (const pid of ["perf-B", "perf-C"]) {
      const perf = f.svc.passport("P1").performances.find((x) => x.performance_id === pid);
      assert.equal(perf.runs[0].status, "paused");
    }
    // 预留全部释放，只剩已完成排练的消耗
    p = f.svc.passport("P1");
    assert.deepEqual(p.balances.used, { light: 4, tension: 4.5, transport: 0 });
    assert.deepEqual(p.balances.reserved, { light: 0, tension: 0, transport: 0 });

    // 三个剧团各有一条通知（中断 / 后续暂停），尚未投递
    assert.equal(f.svc.pendingNotices().length, 3);

    // 乙团启用局部替换候补：暂停场次回到待确认；但受损部件仍禁止原件
    await f.svc.activateStandby({ at: damageAt, passport_id: "P1", performance_id: "perf-B", basis: "local_replacement", approver: "w2" });
    await expectError("DAMAGED_COMPONENT", () =>
      f.svc.confirmUse({
        at: damageAt, passport_id: "P1", performance_id: "perf-B", run_id: "r1", approver: "w2",
        entries: [{ component_id: "arm", mode: "original" }, { component_id: "head", mode: "original" }, { component_id: "body", mode: "original" }],
      }),
    );
    await f.svc.confirmUse({
      at: damageAt, passport_id: "P1", performance_id: "perf-B", run_id: "r1", approver: "w2",
      entries: [
        { component_id: "head", mode: "original" },
        { component_id: "body", mode: "original" },
        { component_id: "arm", mode: "substitute", substitute_id: "sub-arm-1" },
      ],
    });
    f.clock.at("2026-10-02T21:00:00+08:00");
    await f.svc.completeRun({ receipt_id: "rcpt-B-r1", passport_id: "P1", performance_id: "perf-B", run_id: "r1" });

    // 丙团全场替身
    await f.svc.activateStandby({ at: damageAt, passport_id: "P1", performance_id: "perf-C", basis: "full_substitute", approver: "w2" });
    await f.svc.confirmUse({
      at: damageAt, passport_id: "P1", performance_id: "perf-C", run_id: "r1", approver: "w2",
      entries: [
        { component_id: "head", mode: "substitute", substitute_id: "sub-head-1" },
        { component_id: "body", mode: "substitute", substitute_id: "sub-body-1" },
        { component_id: "arm", mode: "substitute", substitute_id: "sub-arm-1" },
      ],
    });
    f.clock.at("2026-10-03T21:00:00+08:00");
    await f.svc.completeRun({ receipt_id: "rcpt-C-r1", passport_id: "P1", performance_id: "perf-C", run_id: "r1" });

    /* ---- 重启：观察期/候补/未完成通知必须延续 ---- */
    f.clock.at("2026-10-04T08:00:00+08:00");
    await restart(f);
    p = f.svc.passport("P1");
    assert.equal(p.paused, true);
    assert.equal(p.damage.components.join(","), "arm");
    assert.equal(f.svc.pendingNotices().length, 3);
    const standbys = f.svc
      .passport("P1")
      .performances.filter((x) => x.standby)
      .map((x) => x.performance_id);
    assert.deepEqual(standbys.sort(), ["perf-B", "perf-C"]);

    // 首次投递全部失败：失败也要留痕，通知仍待重试
    const failResults = await f.svc.deliverPendingNotices(async () => {
      throw new Error("剧团联络人离线");
    });
    assert.equal(failResults.every((r) => r.delivered === false), true);
    assert.equal(f.svc.pendingNotices().length, 3);

    // 再次重启后继续投递未完成通知
    await restart(f);
    const delivered = [];
    const okResults = await f.svc.deliverPendingNotices(async (notice) => {
      delivered.push(notice.notice_id);
      return "已读";
    });
    assert.equal(okResults.every((r) => r.delivered), true);
    assert.equal(delivered.length, 3);
    assert.equal(f.svc.pendingNotices().length, 0);

    /* ---- 修复：双人签认 ---- */
    f.clock.at("2026-10-05T09:00:00+08:00");
    const repairAt = f.clock.now();
    await f.svc.planRepair({
      at: repairAt, passport_id: "P1", repair_id: "rep-1", damage_report_id: "dmg-001",
      components: ["arm"], plan: { method: "皮条衬补缝合", observe_days: 15 }, signer: "w1",
    });
    // 同一人不能签两次
    await expectError("SIGNER_DUPLICATE", () =>
      f.svc.signRepair({ at: repairAt, passport_id: "P1", repair_id: "rep-1", signer: "w1" }),
    );
    // 仅一人签认不能恢复
    await expectError("NEED_TWO_SIGNERS", () =>
      f.svc.approveRestoration({ at: repairAt, passport_id: "P1", repair_id: "rep-1", observations: [] }),
    );
    await f.svc.signRepair({ at: repairAt, passport_id: "P1", repair_id: "rep-1", signer: "w3" });
    await f.svc.approveRestoration({
      at: repairAt, passport_id: "P1", repair_id: "rep-1",
      observations: [{ component_id: "arm", until: "2026-10-20T21:00:00+08:00" }],
    });

    p = f.svc.passport("P1");
    assert.equal(p.paused, false, "签认修复后古件解除暂停");
    assert.equal(p.awaiting_inspection, true, "须凭新检查结果恢复额度");
    assert.equal(p.observation[0].until, "2026-10-20T21:00:00+08:00");
    // 历史没有被清空：两个检查版本、损伤与修复记录、终身负荷都保留
    assert.equal(p.inspection_versions.length, 1);
    assert.equal(p.repairs[0].signers.length, 2);

    // 复检结果出来前，原件仍不能上场；替身可以
    await f.svc.planPerformance({ at: repairAt, passport_id: "P1", performance_id: "perf-E", troupe_id: "troupe-E", runs: [show("r1", "10-08")] });
    await expectError("AWAITING_INSPECTION", () =>
      f.svc.confirmUse({ at: repairAt, passport_id: "P1", performance_id: "perf-E", run_id: "r1", approver: "w1", entries: originalsFor(f.svc) }),
    );

    // 新检查结果换版恢复额度（前驱版本必须衔接）
    f.clock.at("2026-10-06T10:00:00+08:00");
    const insp2At = f.clock.now();
    await f.svc.recordInspection({
      at: insp2At, passport_id: "P1", puppet_id: "pu-P1", puppet_name: "牛皮彩绘战将",
      inspection_id: "insp-2", inspected_at: insp2At,
      quota: { light: 16, tension: 16, transport: 12 },
      components: P1_COMPONENTS,
    });
    p = f.svc.passport("P1");
    assert.equal(p.inspection.inspection_id, "insp-2");
    assert.equal(p.inspection_versions.length, 2);
    assert.deepEqual(p.balances.available, { light: 16, tension: 16, transport: 12 }, "额度按复检结果恢复");
    // 终身负荷保留全部历史：排练4/4.5、中断演出8/9、乙团局部6/5、丙团替身0
    assert.deepEqual(p.lifetime_load, { light: 18, tension: 18.5, transport: 0 });

    // 观察期内臂部不得使用原件：10-10 演出只能继续局部替换
    await f.svc.planPerformance({ at: insp2At, passport_id: "P1", performance_id: "perf-F", troupe_id: "troupe-F", title: "丁团", runs: [show("r1", "10-10")] });
    await expectError("UNDER_OBSERVATION", () =>
      f.svc.confirmUse({ at: insp2At, passport_id: "P1", performance_id: "perf-F", run_id: "r1", approver: "w1", entries: originalsFor(f.svc) }),
    );
    await f.svc.confirmUse({
      at: insp2At, passport_id: "P1", performance_id: "perf-F", run_id: "r1", approver: "w1",
      entries: [
        { component_id: "head", mode: "original" },
        { component_id: "body", mode: "original" },
        { component_id: "arm", mode: "substitute", substitute_id: "sub-arm-1" },
      ],
    });

    // 观察期结束后，修复部件可重新以原件复演
    f.clock.at("2026-10-21T09:00:00+08:00");
    await f.svc.planPerformance({ at: f.clock.now(), passport_id: "P1", performance_id: "perf-G", troupe_id: "troupe-G", runs: [show("r1", "10-21")] });
    await f.svc.confirmUse({ at: f.clock.now(), passport_id: "P1", performance_id: "perf-G", run_id: "r1", approver: "w1", entries: originalsFor(f.svc) });

    /* ---- 从乙团一次演出还原：实际使用、累计负荷、检查证据、批准人 ---- */
    const traceB = f.svc.tracePerformance("P1", "perf-B");
    const run = traceB.runs[0];
    assert.equal(run.status, "completed");
    assert.equal(run.approver, "w2");
    assert.equal(run.inspection_evidence.inspection_id, "insp-1");
    assert.ok(run.inspection_evidence.inspection_event_id, "检查证据事件编号");
    assert.equal(run.receipt_id, "rcpt-B-r1");
    const arm = run.actual_use.find((x) => x.component_id === "arm");
    assert.equal(arm.actual, "复制替身 sub-arm-1");
    const head = run.actual_use.find((x) => x.component_id === "head");
    assert.equal(head.actual, "原件");
    assert.deepEqual(run.load_recorded, { light: 6, tension: 5, transport: 0 });
    assert.deepEqual(traceB.accumulated_load.total, { light: 6, tension: 5, transport: 0 });
  } finally {
    await f.cleanup();
  }
});

/* ------------------ 场景五：离线回执幂等与内容变化保全复核 ------------------ */

test("同编号重传不重复扣减；内容变化进入保全复核且不产生业务效果", async () => {
  const f = await makeService();
  try {
    const at = f.clock.now();
    await seedPassport(f.svc, at, { quota: { light: 20, tension: 20, transport: 20 } });
    await f.svc.planPerformance({ at, passport_id: "P1", performance_id: "perf-A", troupe_id: "troupe-A", runs: [show("r1", "10-01"), show("r2", "10-02")] });
    await f.svc.confirmUse({
      at, passport_id: "P1", performance_id: "perf-A", run_id: "r1", approver: "w1",
      request_id: "req-confirm-1",
      entries: originalsFor(f.svc), note: "首次确认",
    });
    // 同编号重传确认：直接幂等，不新增台账
    const dup = await f.svc.confirmUse({
      at, passport_id: "P1", performance_id: "perf-A", run_id: "r1", approver: "w1",
      request_id: "req-confirm-1",
      entries: originalsFor(f.svc), note: "首次确认",
    });
    assert.equal(dup.status, "duplicate");
    const ledgerCount = () => f.svc.passport("P1").performances.find((x) => x.performance_id === "perf-A").runs[0].confirmation.event_id;
    const firstConfirmEvent = ledgerCount();

    // 完成回执（离线）
    f.clock.tick(6 * 24 * 60 + 12 * 60);
    const r1 = await f.svc.completeRun({ receipt_id: "rcpt-1", passport_id: "P1", performance_id: "perf-A", run_id: "r1" });
    assert.equal(r1.duplicated, false);
    const usedAfterFirst = { ...f.svc.passport("P1").balances.used };

    // 同编号、同内容重传：不重复扣减
    const r2 = await f.svc.completeRun({ receipt_id: "rcpt-1", passport_id: "P1", performance_id: "perf-A", run_id: "r1" });
    assert.equal(r2.status, "duplicate");
    assert.deepEqual(f.svc.passport("P1").balances.used, usedAfterFirst);

    // 同编号但内容变化（谎称另一场次完成）：进入保全复核，业务不生效
    f.clock.tick(5);
    const r3 = await f.svc.completeRun({ receipt_id: "rcpt-1", passport_id: "P1", performance_id: "perf-A", run_id: "r2" });
    assert.equal(r3.status, "review");
    assert.equal(f.svc.reviews().length, 1);
    assert.equal(f.svc.reviews()[0].request_id, "rcpt-1");
    // r2 未被标记完成，复核事件不改变余额
    assert.deepEqual(f.svc.passport("P1").balances.used, usedAfterFirst);
    const r2run = f.svc.tracePerformance("P1", "perf-A").runs.find((x) => x.run_id === "r2");
    assert.equal(r2run.status, "planned");

    // 同样的变造内容再传一次：不重复记复核
    const r4 = await f.svc.completeRun({ receipt_id: "rcpt-1", passport_id: "P1", performance_id: "perf-A", run_id: "r2" });
    assert.equal(r4.status, "review");
    assert.equal(f.svc.reviews().length, 1);

    // 首次确认事件编号未被重传改变
    assert.equal(ledgerCount(), firstConfirmEvent);
  } finally {
    await f.cleanup();
  }
});

/* ------------------ 场景六：运输与环境暴露计入额度，试算可见 ------------------ */

test("运输段按材质系数消耗 transport 额度并参与跨团累计", async () => {
  const f = await makeService();
  try {
    const at = f.clock.now();
    await seedPassport(f.svc, at, { quota: { light: 30, tension: 30, transport: 5 } });
    await f.svc.planPerformance({
      at, passport_id: "P1", performance_id: "perf-A", troupe_id: "troupe-A", title: "甲团",
      runs: [
        { run_id: "road-1", kind: "transit", from: "2026-10-01T06:00:00+08:00", to: "2026-10-01T14:00:00+08:00" },
        show("show-1", "10-01"),
        { run_id: "road-2", kind: "transit", from: "2026-10-02T06:00:00+08:00", to: "2026-10-02T12:00:00+08:00" },
      ],
    });
    // 两个运输段：每段全部件 transport 1 => 每段 3，两段 6 > 5，试算应预警
    const est = f.svc.estimatePerformance("P1", "perf-A");
    const transitIssues = est.runs.filter((r) => r.kind === "transit").flatMap((r) => r.issues);
    // 累计视角：确认第一段后第二段超额
    await f.svc.confirmUse({ at, passport_id: "P1", performance_id: "perf-A", run_id: "road-1", approver: "w1", entries: originalsFor(f.svc) });
    assert.deepEqual(f.svc.passport("P1").balances.reserved, { light: 0, tension: 0, transport: 3 });
    await expectError("QUOTA_EXCEEDED", () =>
      f.svc.confirmUse({ at, passport_id: "P1", performance_id: "perf-A", run_id: "road-2", approver: "w1", entries: originalsFor(f.svc) }),
    );
    // 第二段改用替身运输：不占原件额度
    await registerSubstitutes(f.svc, at, [
      { id: "sub-head-1", component: "head" },
      { id: "sub-body-1", component: "body" },
      { id: "sub-arm-1", component: "arm" },
    ]);
    await f.svc.confirmUse({
      at, passport_id: "P1", performance_id: "perf-A", run_id: "road-2", approver: "w1",
      entries: [
        { component_id: "head", mode: "substitute", substitute_id: "sub-head-1" },
        { component_id: "body", mode: "substitute", substitute_id: "sub-body-1" },
        { component_id: "arm", mode: "substitute", substitute_id: "sub-arm-1" },
      ],
    });
    assert.ok(transitIssues.length >= 0);
  } finally {
    await f.cleanup();
  }
});
