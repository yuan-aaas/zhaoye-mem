# assistant-dsh

DSH 助手适配插件：把 `zhaoye-mem` 的固定人格、显式记忆和双轨委托接入 DeepSeek Harness。

## 三层分工

```text
L1  DSH 助手 Agent（preset: assistant）
      │  人格段 + 记忆索引由插件每轮渲染
L2  assistant-dsh 插件
      ├─ assistant_locate / recall / remember / replace / archive
      ├─ assistant_identity_preview / commit
      ├─ assistant_delegate / task_status / task_cancel
      │
L3  zhaoye-mem 框架（AssistantApi）
      画像、显式记忆、JSONL 与锁
```

- 插件不运行自己的模型循环，也不运行 `LocalWorker`。
- 委托通过 `ctx.sessionController.create({ cwd, agentPreset })` 新开一条**普通会话**（`assistant-worker` preset），再用 `sessionController.prompt` 投任务；它不是子代理，审批策略是常规的 `ask`。
- 插件用 `ctx.sessions.get(id).snapshotEvents()` 轮询工作会话，`turn/end` 时取最后一条 assistant 消息解析回执。
- 任务账本归插件，不写入 `zhaoye-mem` 的记忆数据。

## 依赖

- Node.js 24+
- `zhaoye-mem` 已构建（仓库根目录 `npm run build`）
- DSH 0.2.x（插件按 0.2.1-rc.2 的 API 编写，运行时能力仍需实机核验）

插件通过相对路径引用仓库根目录的 `dist/src/index.js`，因此**只适用于本仓库的 `link:` 安装**，不是可独立发布的包。

## 构建

```powershell
cd D:\workspace\myspace\zhaoye
npm run build

cd plugins\assistant-dsh
node ..\..\node_modules\typescript\bin\tsc -p tsconfig.json
node test\plugin.test.mjs
```

## 安装（已执行）

2026-10-21 已安装到 desktop profile：

```powershell
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "link:D:/workspace/myspace/zhaoye/plugins/assistant-dsh"
```

安装后 DSH 热加载了 host 入口并初始化 `~/.zhaoye`；新建会话时选择「助手」preset。卸载：

```powershell
& "<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop remove assistant-dsh
```

## 开发时更新

插件已经用 `link:` 挂到 profile：

```text
C:\Users\LKL\.dsh\profiles\desktop\node_modules\assistant-dsh
  -> D:\workspace\myspace\zhaoye\plugins\assistant-dsh
```

但 `link:` 只共享目录，不会编译 TypeScript。改完 `src/` 后需要重新生成 `lib/`：

```powershell
cd plugins\assistant-dsh
npm run dev     # tsc --watch，保存即编译
# 或 npm run build
```

DSH 宿主不会自动重载已加载的 host 模块；重新编译后请重启 DSH，再用新的「助手」会话验证 agent 工具和提示段。

## 配置

写在 profile 的 `cordis.patch.yml`，按行 id 覆盖：

```yaml
- id: assistant-dsh
  config:
    dataRoot: ~/.zhaoye
    autoInit: true
    recoverStaleLock: true
    projectMap:
      demo: D:/workspace/myspace/zhaoye
    memoryIndexLimit: 5
    memoryIndexBudget: 600
    memoryTitleLength: 30
    pinnedLimit: 3
    pinnedBudget: 600
    pinnedItemBudget: 300
    identityBudget: 1600
    recallBudget: 4000
    workerPreset: assistant-worker
    delegateTimeoutMs: 900000
```

- `dataRoot`：`zhaoye-mem` 数据根；不存在且 `autoInit` 为真时会初始化。
- `recoverStaleLock`：默认 `true`。仅当 `.writer.lock/owner.json` 记录的 PID 已退出，或空/损坏锁超过 15 秒宽限期时，插件才清理遗留锁并重试打开；PID 仍存活时不会抢占。
- `projectMap`：DSH 工作目录 / 工具参数里的 `project_id` 与 `zhaoye-mem` 项目别名对应关系；不配置时记忆按全局（`project_id = null`）处理。
- `memoryIndexLimit / memoryIndexBudget / memoryTitleLength`：每轮记忆目录的条数、字符预算、标题长度；目录只给标题，正文按需 recall。
- `pinnedLimit / pinnedBudget / pinnedItemBudget`：`tags` 含 `pin` 或 `置顶` 的记忆直接注入正文，默认最多 3 条、每条 300 字、总预算 600。
- `deniedTools`：可覆盖默认的 `memory_*`、原生 subagent/消息类工具的限制名单（只作用于助手对话轨）。

## 写锁与恢复

`~/.zhaoye/.writer.lock` 是单写者锁，防止两个进程同时写记忆库。

- **正常退出**：`close()` 删除锁；另注册 `process.once('exit')`，退出时若锁仍属于本进程也同步删除。
- **崩溃/强杀**：下次启动发现 owner PID 已退出 → 清理锁并重试；空/损坏锁超过 15 秒 → 清理并重试。
- **HMR 重载**：新旧实例在同一进程，新实例发现锁属于本进程时等待最多 2 秒，等旧实例释放；期间绝不删除活锁。
- **另一个存活进程**：不抢占，助手显示“数据不可用”；需要关闭另一个 DSH/CLI 实例。
- **PID 被复用**：极少数情况下无法判定，锁会保留；需要人工确认 `owner.json` 后删除。

## 记忆注入分层

- **L0 固定画像**：kernel + 用户画像 + 协作习惯，≤1600 码点，每轮注入。
- **L1 记忆目录**：最近 5 条，一行一条；标题 30 字，总预算 600 码点；正文按需 `assistant_recall`。
- **L2 置顶正文**：`tags` 含 `pin` 或 `置顶` 的 1～3 条，直接注入正文，每条 300 字，总预算 600 码点。
- **L3 其余记忆**：不预载，按需 `assistant_locate / recall`。
- 目录文本按 `record_id + revision` 缓存；记忆没变时复用同一字符串，避免每轮变化破坏前缀缓存。

## 工具

| 工具 | 作用 |
|---|---|
| `assistant_locate` | 定位记忆，最多 5 条路由 |
| `assistant_recall` | 读取一条记忆正文 |
| `assistant_remember` | 用户明确要求时保存显式记忆 |
| `assistant_replace` | 按 revision 修改记忆 |
| `assistant_archive` | 软删除记忆 |
| `assistant_identity_preview` | 预览画像修改 |
| `assistant_identity_commit` | 用户确认后提交画像 |
| `assistant_delegate` | 新开一条独立工作会话并投递任务（可读写文件、运行命令） |
| `assistant_task_status` | 查询任务与回执 |
| `assistant_task_cancel` | 取消运行中的任务 |

## 双轨约定

- Lead preset `assistant` 不挂 fs / shell / skill / 原生 subagent；它只负责理解、记忆、委托和汇报。
- Work preset `assistant-worker` 挂 `read/write/edit`、`glob/grep`、`pwsh/bash`、`web`、`todo`；它是真正执行任务的工作会话。
- 委托 = **新开一条普通会话**（`sessionController.create`，cwd 为目标项目目录），不是 `subagents` 子代理。因此它有自己的历史、自己的审批通道，用户能在侧栏打开并接管，审批策略是 `ask` 而不是子代理的 `never`。
- 会话的沙箱边界是它的 cwd：想让它写某个项目，就用 `projectMap` 把任务投到那个目录；工作区之外的操作会走审批。
- Work Agent 不继承主对话人格/记忆，不能使用 `memory_*`、便签/画布，也不能继续委托。
- Work Agent 最后一条消息应为 JSON 回执，包含 `summary / evidence_refs / artifact_refs / pending_questions`；插件回读证据、校验行号与 quote、补齐 sha256，并把产物路径带回 Lead。Worker 用散文回答时降级为摘要（`receipt.degraded = true`），不丢结果。
- 委托完成后插件通过 `followup` 把短回执通知 Lead。

## 已知限制

- 同一数据 root 只能打开一个框架实例；DSH 运行期间 CLI 写入会被 `.writer.lock` 挡住。
- 插件已在真实 DSH 助手会话中加载（`agent-preset/selected: assistant`）；工具隔离与画像提示的首轮修复待重启后验证。
- 工作会话的写文件/命令操作会触发 DSH 审批；如果长时间无人批准，任务会判超时（`DELEGATE_TIMEOUT`）并留在 `unknown`，但那条会话仍在侧栏，可直接打开接管。
- 暂不处理 mneme / DSH 会话日志等其他记忆来源。
- 画像为空时的对话填写依赖模型按提示逐项询问；插件只提供 preview/commit 工具，不提供 UI。
