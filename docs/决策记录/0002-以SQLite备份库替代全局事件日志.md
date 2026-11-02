# 0002. 以 SQLite 备份库替代全局事件日志

- **状态**：已接受
- **日期**：2026-10-30
- **决策者**：袁冶、助手
- **触及章节**：01 不变量 I2/I3/I5、03 数据契约与恢复、04 M1 写入协议、`packages/contracts/src/events.ts`、数据根布局
- **取代**：[架构设计 v2 历史草案](../归档/架构设计-v2历史草案.md) 中的 §5 数据根 v3 与事件日志、§6.1 提交序列器、§7.6 索引检查点、I1/I2 原文

## 背景

2026-10-26 的架构草案把“单一提交序列 + 追加日志是唯一事实源 + 投影重放”写成了不变量 I1/I2，并据此设计了 `journal/`、hash 链（`prev`/`digest`/`fingerprint`）、提交序列器与投影重建。`packages/contracts/src/events.ts` 里的 `EventEnvelopeSchema`（`v: 3`、`seq`、`prev`、`digest`）就是这套方案的落点。

2026-10-28 起项目定位改为**外部管理与编排框架**：

- 全量记忆是**外部记忆系统的只读备份副本**，落在 SQLite，而不是照夜自建的统一记忆事实库；
- 三类数据域各有权威格式（JSON / SQLite / 文件），**不存在跨存储事务**；
- 备份批次与版本表已经能表达恢复与来源追踪，不需要再叠一层全系统 hash 链；
- 项目从未发布，`journal/` 布局没有真实用户数据。

继续保留事件日志会带来三个具体成本：所有写入必须建模为事件并维护链；JSON 与 SQLite 双写无法原子，仍要靠批次状态兜底；契约里的事件闭集随三域演化不断膨胀。

## 决策

1. **取消全局事件日志与 hash 链作为事实源。** 人格 JSON、备份 SQLite、资产文件与 manifest 各自是权威数据；不存在“重放日志得到状态”的路径。
2. **派生数据可重建、不可反写。** Markdown 投影、FTS 索引、路由/热度索引都是派生物：删掉可重建，手工修改不影响权威读取。
3. **幂等与审计用按域的操作记录。** M1 用 `identity/operations.jsonl`（有界轮转，非事实源）；M2 起备份域用 SQLite 的 `import_batches` 与操作表。操作记录丢失时，权威数据仍可读，只损失“重复请求返回原回执”的能力。
4. **并发与一致性由四件事承担**：presence 单活、`operation_id` 幂等、`expected_revision` CAS、临时文件 + rename 原子替换。SQLite 侧由事务与 WAL 在线备份保证。
5. **数据根 `schema_version` 定为 1（新布局），不迁移旧 v3 布局。** 检出 `journal/`、`projections/` 直接报 `SCHEMA_MIGRATION_REQUIRED`。
6. **契约删除 `events.ts`。** `EventEnvelope`、`EVENT_KINDS` 不再导出；新增 `limits.ts`、`defaults.ts`，错误码按 03 §6 重排。

## 后果

- `@zhaoye/contracts` 发生破坏性变更；由于包不对外发布，只影响本仓代码与测试。
- 里程碑从 journal 版 M1–M6 重排为 M1–M5（见 02 §5）；原 M1“存储内核（journal/sequencer/投影）”作废，改为“契约 + 人格记忆 + 数据根 + presence”。
- 测试重心从“删除投影后重放逐字节一致”转为“重开一致、CAS/幂等、损坏可检出、presence 单活”。
- presence 不依赖日志，`owner.json` 与 `last-released.json` 自足；崩溃恢复靠 PID/心跳判定。
- 备份恢复走 SQLite 在线备份，不再需要“重放校验”。

## 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 保留 journal 作为操作审计 | 与三域独立提交冲突；每个域都要维护链；审计需求用操作记录 + 版本快照 + 批次表已足够 |
| 用 hash 链校验备份完整性 | 内容摘要（sha256）+ 批次完整性 + SQLite `integrity_check` 已覆盖；链本身不提供额外恢复能力 |
| 保留 v3 布局并写迁移器 | 从未发布，没有真实数据；迁移器会锁死旧模型，增加无收益的兼容层 |
| 用 append-only 日志存人格历史 | 版本快照目录更直观，回滚与 diff 更简单，单文件上限可控 |

## 验证

1. `packages/contracts` 中不存在 `EventEnvelope` / `EVENT_KINDS`（全文检索为空）。
2. M1 退出条件中的 CAS、幂等、重开一致、损坏检测、presence 单活用例全部通过（04 §10）。
3. `pnpm verify` / `scripts/verify.ps1` 退出码 0，depcruise 0 违规。
4. 01 的 I2/I3/I5 与新实现一致：第二实例被拒、陈旧 revision 冲突、重复操作返回原回执、投影可重建。

## 影响文档

- [01-架构基线](../01-架构基线.md)：重写不变量 I2/I3/I5，删除“日志是唯一事实源”。
- [02-工程与里程碑](../02-工程与里程碑.md)：里程碑重排，删除 journal 相关任务。
- [03-记忆核心技术设计](../03-记忆核心技术设计.md)：数据契约、恢复矩阵、预算（删除 `journalEventBytes`）。
- [04-M1 契约与人格记忆开发设计](../04-M1-契约与人格记忆开发设计.md)：写入协议、操作记录、数据根守护表。
- [docs/README](../README.md)：把本文加入决策记录索引。
