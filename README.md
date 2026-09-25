# 皮影古件演出负荷护照

在古件检查、演出安排、替身分配与修复事件的基础约定上，本服务为每件古件建立**演出负荷护照**：
跨剧团巡演时累计强光、牵拉、运输与环境暴露的总消耗，排期先算消耗、再由保护员决定
原件 / 复制替身 / 局部替换，并把修复后的观察期纳入同一条排期约束链。

## 解决的问题

- 同一件古件被多个剧团分别预订，单场检查都合格，却没人累计跨场总负荷。
- 修复后的观察期可能被下一场排练绕过。
- 同一部件被多个方案重复引用，缺少原子占用。
- 现场异常影响范围不清；离线回执重传可能重复扣减。

## 核心约定

- **事件溯源**：所有事实只追加在 JSONL 事件日志（`EventStore`），历史不原地改写；更正产生后继记录。
  服务重启后对日志整体重放（`fold`）即可恢复观察期、候补替换、未完成通知与全部占用。
- **检查版本与额度**：每次检查（初检/例行/修复后复检）产生一个版本，额度按材料脆弱等级折算并绑定版本。
  修复双人签认后凭新检查结果开启新版本与额度，**旧版本下的历史用量原样保留**。
- **先算后批**：`requestBooking` 只登记申请并给出四维度消耗估算（含连续使用疲劳、运输与途中环境暴露）；
  `decideBooking` 才由保护员签认并原子占用部件。超额度时原件被拒，可改用替身或局部替换。
- **原子部件占用**：部件在时间窗内独占；同批次任一部件冲突则整场拒绝，不留半占用。
  同一部件不同时间窗可被不同剧团顺序使用。
- **异常范围暂停**：整件异常暂停该古件后续原件场次；局部异常只暂停占用受损部件的场次；
  使用替身或不涉损部件的场次继续；**已完成演出保持当时依据不变**。
- **修复双人签认**：修复方案须两个不同自然人签认；完成后按新检查结果恢复额度、进入观察期、
  关闭关联异常，未完成场次转为“须按新版本重新签认”。观察期内原件额度减半且须明确确认，排练同等受限。
- **离线回执幂等**：回执带 `client_message_id` 与 `receipt_id`。同编号内容一致的重传直接返回首次凭证、
  不重复扣减；同编号内容变化（或回执编号被挪用）不扣减，转入**保全复核**。
- **全证据还原**：`getPerformance` 可从一次演出还原实际使用的原件/替身部件、四维度实际与累计负荷、
  检查版本与证据引用、以及每一步的批准人。

## 代码结构

- `src/validator.js`：基础事件信封校验（沿用）。
- `src/domain.ts`：信封与护照领域类型。
- `src/passport/constants.js`：负荷维度、脆弱等级额度折算、恢复期、观察期与估算系数。
- `src/passport/events.js`：护照事件类型总表、内容哈希与事件信封构造。
- `src/passport/event-store.js`：追加式 JSONL 存储，批量“临时文件 + rename”原子提交。
- `src/passport/load.js`：消耗估算（强光/牵拉/运输/环境、连续使用疲劳、局部系数）、实际对账、额度判定。
- `src/passport/projection.js`：事件折叠为护照、预约、部件占用、修复、通知与幂等台账等读模型。
- `src/passport/service.js`：应用服务（检查、排期估算、签认、改期、回执、异常、修复、通知、复核、查询）。
- `contracts/domain.schema.json`：事件名与聚合类型契约。
- `tests/passport.test.js`：跨团改期、局部损伤、修复复演、离线幂等、重启续跑、演出还原等自动化重放。

## 典型流程

```js
const svc = new PassportService("./data/events.jsonl");

// 1. 检查建照：材料脆弱项 + 检查版本 + 额度
svc.inspectObject({ object_id: "O1", inspection: { inspector_id: "keeper-1",
  vulnerability_level: 2, component_ids: ["head", "arm", "body"],
  vulnerabilities: [{ part_id: "head", note: "强光褪色" }] } });

// 2. 剧团申请：返回估算消耗、连续使用判定与额度预判
const { assessment } = svc.requestBooking({ booking_id: "BK-1", plan_id: "P-1",
  troupe_id: "troupe-A", object_id: "O1", requested_by: "stage-a",
  scheme: { starts_at, ends_at, light_minutes: 20, tension_minutes: 15,
            environment_minutes: 40, transport_km: 5, part_ids: ["head", "arm", "body"] } });

// 3. 保护员签认：original / substitute / partial / rejected；超额度或部件冲突会被拒
svc.decideBooking({ booking_id: "BK-1", decision: "partial", decided_by: "keeper-1",
  replaced_part_ids: ["head"], substitutes: ["SUB-HEAD"] });

// 4. 现场离线回执（可补传）
svc.recordUsage({ booking_id: "BK-1", receipt_id: "R-1", client_message_id: "M-1",
  recorded_mode: "partial", actual_components: ["arm", "body"], actual_substitutes: ["SUB-HEAD"],
  actual_load: { light: 12, tension: 9, transport: 8, environment: 12 } });

// 5. 异常 → 修复双人签认 → 新检查版本恢复额度 + 观察期 → 重新签认复演
svc.reportIncident({ incident_id: "INC-1", object_id: "O1", part_ids: ["arm"], reported_by: "stage-a" });
svc.proposeRepair({ repair_id: "RP-1", object_id: "O1", incident_id: "INC-1", part_ids: ["arm"],
  proposed_by: "cons-a", target_inspection: { vulnerability_level: 2, vulnerabilities: [] } });
svc.signRepair({ repair_id: "RP-1", signer_id: "cons-a", role: "lead" });
svc.signRepair({ repair_id: "RP-1", signer_id: "cons-b", role: "reviewer" });
svc.completeRepair({ repair_id: "RP-1", inspection: { inspector_id: "keeper-1",
  vulnerability_level: 2, component_ids: ["head", "arm", "body"] } });
svc.decideBooking({ booking_id: "BK-1", decision: "original", decided_by: "keeper-1",
  observation_acknowledged: true });

// 6. 还原一次演出的全部依据
svc.getPerformance("BK-1");
svc.getPassport("O1"); // 各检查版本额度/已用、观察期、部件占用、后续场次
```

## 负荷估算口径

- 强光 = 照射分钟 × 灯光档位系数（排练 0.5 / 普通 1 / 强灯 1.5）。
- 牵拉 = 操纵分钟 × 系数。
- 运输 = 公里 × 系数 + 每段固定装卸消耗（往返两段）。
- 环境 = 现场暴露分钟 + 运输途中公里暴露。
- **连续使用**：距上一场原件使用不足 20 小时恢复期时，强光与牵拉按每缺一小时追加疲劳。
- 局部替换：整体负荷 ×0.7；整件替身不占用古件额度。
- 观察期（修复后 48 小时）内原件可用额度减半，常量均可在 `src/passport/constants.js` 调整。

## 本地检查

```bash
npm test     # node:test：基础契约 + 护照重放（跨团改期/局部损伤/修复复演/离线幂等/重启续跑/演出还原）
npm run build
```

上述命令均在单个 Linux 应用容器内执行，不需要外部服务。

## 领域边界

事件一旦被接收，其标识、发生时间和版本不应被原地改写；业务更正产生后继记录。
涉及个人、机构或商业敏感信息时，调用方只读取完成职责所必需的字段。
