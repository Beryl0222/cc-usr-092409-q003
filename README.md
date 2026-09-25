# 皮影古件演出负荷护照

本仓库保存演出负荷护照服务的领域模型、事件约定与自动化重放测试。
目标：同一件古件被多个剧团分别预订时，累计它在**强光、牵拉、运输**三维上的总负荷；
修复后的观察期不能被下一场排练绕过；保护员对每场演出使用原件、复制替身还是局部替换作出可追溯的决定。

## 核心规则

1. **护照随检查发证**：`OBJECT_INSPECTED` 为每件古件建立护照，记录材料脆弱项（部件 + 材质系数）、
   检查版本号与三维可用额度。修复后只能凭**新检查结果**换版恢复额度，历史台账、损伤与修复记录不清空。
2. **排期先算消耗再确认**：服务提供试算（连续使用、运输段、环境暴露按部件材质系数折算），
   保护员确认时系统校验剩余额度；超额预订被拒绝，可改用复制替身或局部替换。
3. **共享部件原子占用**：每个方案对本件部件、`shared_part_id` 共享部件和复制替身的时间窗占用做全局校验；
   一个提交批次中的事件全部通过才落盘，任一冲突整批回滚，不留半占。
4. **现场异常只暂停相关古件与后续场次**：`DAMAGE_REPORTED` 中断当场、原子暂停该古件在各剧团
   触碰原件的后续场次并通知剧团；**已完成的演出保持确认当时的依据**，不回填、不重算。
5. **候补替换**：暂停演出可启用 `full_substitute`（全场替身）或 `local_replacement`（局部替换），
   暂停场次回到待确认，由保护员重新确认；受损部件在修复复检前不得以原件上场。
6. **修复双人签认**：`REPAIR_PLANNED`（首签）+ `REPAIR_SIGN_RECORDED`（复核）后才能
   `RESTORATION_APPROVED`：解除暂停、设定观察期；额度等新检查结果登记后恢复。
   观察期内对应部件不得使用原件（替身/局部替换除外）。
7. **离线回执幂等**：现场回执带 `receipt_id`，同编号同内容重传直接返回既有结果、不重复扣减；
   同编号但内容变化只追加 `REVIEW_FLAGGED` 进入保全复核，命令不产生业务效果。
8. **重启可恢复**：状态全部由 JSONL 事件日志重放（带哈希链校验）。重启后观察期继续计时、
   候补方案保留、未投递通知继续投递、幂等索引继续生效。
9. **一次演出可还原**：`tracePerformance` 还原每场实际使用的原件/复制替身、逐部件负荷、
   所依据的检查版本与证据事件、批准人、完成回执编号。

## 目录

- `contracts/domain.schema.json`：领域事件信封、聚合类型与事件名称清单。
- `data/sample.json`：基础事件信封中文样例（保持与基线兼容）。
- `src/validator.js`：基础事件信封校验（基线保留）。
- `src/model.js`：纯领域模型——事件折叠、负荷计算、额度/观察期/占用校验、排期试算、演出还原投影。
- `src/store.js`：JSONL 事件存储——追加写、哈希链、批次幂等、乐观版本、启动重放。
- `src/service.js`：保护员应用服务——检查、排期/改期、使用确认、异常暂停、候补、
  修复签认、离线回执、通知 outbox、保全复核。
- `tests/contract.test.js`：基线信封约定。
- `tests/passport.test.js`：护照流程自动化重放（见下）。

## 负荷模型

三个维度：`light`（强光）、`tension`（牵拉）、`transport`（运输/环境暴露）。

| 阶段 | light | tension | transport |
| --- | --- | --- | --- |
| 排练 rehearsal（每部件） | 1 | 1 | 0 |
| 正式演出 performance（每部件） | 2 | 2 | 0 |
| 运输段 transit（每部件） | 0 | 0 | 1 |

部件实际消耗 = 阶段基数 × 部件材质系数（检查时登记，例如彩绘头部怕光 `light=2`、
关节连接臂怕牵拉 `tension=2`）。使用复制替身的部件不消耗原件额度，但方案与实际使用仍记录在案。

护照余额：`可用 = 检查额度 − 已完成消耗 − 已确认未完成预留`。改期或取消原子释放预留。

## 事件目录

| 事件 | 聚合 | 说明 |
| --- | --- | --- |
| `OBJECT_INSPECTED` | puppet_object | 首检发证或修复后凭新检查换版（`predecessor_inspection_id` 衔接） |
| `SUBSTITUTE_REGISTERED` | substitute | 登记复制替身及其可替换部件 |
| `PERFORMANCE_PLANNED` | performance_plan | 登记演出与场次/运输段 |
| `PERFORMANCE_RESCHEDULED` | performance_plan | 改期换版（同批先取消旧确认） |
| `STAGE_USE_CONFIRMED` | performance_plan | 保护员确认原件/替身/局部替换，锁定额度与占用 |
| `STAGE_USE_CANCELLED` | performance_plan | 取消确认，释放预留与占用 |
| `STAGE_COMPLETED` | performance_plan | 现场完成回执（离线、幂等） |
| `DAMAGE_REPORTED` | conservation_action | 现场局部损伤，中断当场并暂停后续原件场次 |
| `PERFORMANCE_PAUSED` / `PERFORMANCE_RESUMED` | performance_plan | 剧团层面暂停/恢复 |
| `STANDBY_ACTIVATED` | performance_plan | 启用全场替身或局部替换候补 |
| `REPAIR_PLANNED` / `REPAIR_SIGN_RECORDED` | conservation_action | 修复方案首签与复核签认 |
| `RESTORATION_APPROVED` | conservation_action | 双人签认后解停、进入观察期、等待复检 |
| `NOTIFICATION_QUEUED/DELIVERED/DELIVERY_FAILED` | notice_outbox | 通知 outbox，重启续投 |
| `REVIEW_FLAGGED` | reconciliation | 同编号重传内容变化的保全复核 |
| `REQUEST_RECORDED` | reconciliation | 幂等请求索引（request/receipt 编号 → 内容哈希 → 效果事件） |

`SUBSTITUTE_ASSIGNED`、`REPAIR_RECORDED`、`CLEARANCE_GRANTED` 为基线保留事件名称。

## 自动化重放场景（`node --test`）

`tests/passport.test.js` 端到端重放：

1. 跨团累计同一古件负荷，超额预订被拦截、局部替换放行；
2. 共享部件被多个古件方案引用时重叠占用被拒，跨护照整批失败不留半占；
3. 跨团改期原子取消旧确认并换版，已完成演出保持当时依据；
4. 局部损伤 → 后续场次暂停 → 候补续演 → 双人签认修复 → 复检恢复额度 →
   观察期约束 → 观察期后原件复演（含两次服务重启：观察期、候补、通知续投延续）；
5. 离线回执同编号重传不重复扣减，内容变化进入保全复核；
6. 运输段按材质系数消耗 transport 额度并参与累计。

## 本地检查

```bash
npm test     # node --test，全部在单容器内运行，无外部依赖
npm run build
```

## 持久化与重启语义

事件日志默认写入构造 `EventStore(filePath)` 时给定的 JSONL 路径。每条记录含
`prev_hash/hash` 哈希链，启动加载时校验，链断裂则拒绝启动。服务无独立数据库，
删除日志即回到空状态；生产部署应将日志放在持久卷并另行备份。
