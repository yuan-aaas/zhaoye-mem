# zhaoye-mem

当前方向（2026-10-21）：交付 DSH 助手插件，按“DSH 助手 Agent → DSH 适配插件 → 助手项目记忆核心”三层分工。委托决策归助手 Agent，宿主会话与委托执行归插件，助手项目框架负责画像和记忆数据处理。修订方案见本地 `docs/plan-assistant/DSH-PLUGIN-PLAN.md`（`docs/` 不入库）。下述运行说明对应现有本地原型，DSH 插件尚未实现。

项目已提供独立的助手框架 API 和记忆核心，插件可以通过公开包入口读取和修改画像、维护显式记忆；通信方式与调用示例见本地 `docs/plan-assistant/FRAMEWORK-ADAPTER-API.md`。本地终端 Lead/Worker 保留为适配原型。技术基线为 Node.js 24、TypeScript strict、JSONL 持久化和 Zod 4 schema。真实 DSH 插件与外部记忆来源尚未接入。

- **GitHub 项目**：https://github.com/yuan-aaas/zhaoye-mem
- **本地路径**：`D:\workspace\myspace\zhaoye`
- **默认分支**：`main`

## 提交约定

```text
<type>: <summary>
```

`type` 取 `feat` / `fix` / `docs` / `chore` / `refactor` / `test`。

## 过程文件

临时脚本、一次性验证产物、抓包/日志、手工复现目录统一放 `plugin_test/`，不进版本库（只保留它的 `README.md` 和 `.gitignore`）。测试产生的临时目录也落在 `plugin_test/.test-tmp/`。

`docs/` 同样不入库：方案、评审、追溯表都只保留在本机。

## Windows 沙箱权限排查

在 DSH 的 `workspace-write` 沙箱里，命令进程跑在 **Low** 完整性级别；工作区根目录带 `Low Mandatory Level (OI)(CI)(NW)` 标记，新建目录会继承它。

- **症状**：`npm run build` / 写文件报 `EPERM`，而根目录、`plugin_test/` 正常。
- **原因**：在 DSH 之外（普通终端、旧进程）创建的目录没有这条 Low 标记，被视为 Medium，低完整性进程不能向上写。
- **确认**：`icacls <目录>` 里出现 `Mandatory Label\Low Mandatory Level` 才正常。
- **处理**：可以重建的目录（如 `dist/`）直接删掉重建，新目录会继承正确标记；删不掉时用一次「完全权限」执行 `Remove-Item <目录> -Recurse -Force` 再构建。
- 不要手工改 ACL。用诊断脚本时，报告与撤销命令落在 `plugin_test/acl-report/`。

另：沙箱禁止管道方式的子进程，`npm test` 里的 `node --test` 会 `spawn EPERM`；逐文件运行 `node dist/test/<name>.test.js` 可绕过。

## 安装与启动

```powershell
cd D:\workspace\myspace\zhaoye
npm ci
npm run build
npm test
node dist/src/main.js init --root .\.local-data --template lead
node dist/src/main.js chat --root .\.local-data --project demo=./fixtures/project
```

未配置模型时，初始化、`doctor` 和明确记忆命令仍可用；普通对话会返回 `MODEL_NOT_CONFIGURED`。配置一个 Chat Completions 兼容端点：

```powershell
$env:MODEL_BASE_URL = 'https://api.deepseek.com/v1'
$env:MODEL_NAME = 'deepseek-chat'
$env:MODEL_API_KEY = '<在当前 PowerShell 会话设置密钥>'
```

运行时读取环境变量，不将 API key 写入项目文件、日志或错误消息。不能使用上述端点的其他服务，应填写其 `/v1` API 根地址和对应模型名。实际兼容性需对每个供应商单独验证。

## 交互命令

在 `chat` 中：

```text
/remember --as user --tag communication 回答请先给结论
/remember --as quote 文章中的原文
/remember 这条记录没有声明观点归属
/recall --project demo 结论
/recall --id <record_id>
/replace --id <record_id> --revision 1 --as user 回答先给结论
/archive --id <record_id> --revision 2
/tasks
/task <task_id>
/retry <task_id>
/cancel <task_id>
/quit
```

每条新记忆会显示 `op_id`。写入结果不明时先用 `doctor` 检查日志，再用同一 `--op-id` 重试，避免重复创建。`--as user` 表示这段内容是用户明确表述，不代表外部事实已核验；引用和未声明归属的记录不会变成用户画像。普通自然语言“记住这个”不会静默持久化。

首次进入聊天且用户画像为空时，会显示一次可选填写入口。输入 `/profile` 可选择“工作搭档 / 私人助理 / 长期伙伴”模板，并填写称呼、长期目标、沟通偏好等；每项均可留空，也可直接聊天，之后再输入 `/profile` 补充。填写后先展示预览，输入“保存”才提交独立画像版本；取消或全部留空不会更改画像。该流程不需要配置模型。模板说明见 [identity-templates.md](presets/identity-templates.md)。

画像维护独立于普通对话和记忆写入，也可使用文件提案：

```powershell
node dist/src/main.js identity preview --root .\.local-data --patch .\profile-patch.json
node dist/src/main.js identity apply --root .\.local-data --proposal <proposal_id> --expected-revision 1
```

patch JSON 只允许 `user_profile`、`habits` 和明确修改过的 `kernel` 字段。用户画像支持部分字段更新；未提供的字段保留，facts 和习惯数组按整组替换。apply 会重新核对提案 hash 与当前 revision。适配插件也可直接调用 `updateIdentity` 一次完成更新，详见公开接口说明。

## 本地数据与限制

- 开发 root 默认 `assistant/.local-data`；用户可显式指定 `--root`。初始化拒绝覆盖未知非空目录。目录内包含 manifest、不可变画像版本、`records.jsonl`、`events.jsonl`、可重建的 `routes.json`、usage 日志和独占 writer lock。
- 日志逐行带 checksum、连续 seq 和幂等 op_id；损坏尾部、中段损坏及不支持 schema 会阻止写入，不会自动删库或抢占遗留锁。
- Lead 只有四个模型工具：`assistant_locate`、`assistant_recall`、`assistant_delegate`、`assistant_task_status`。记忆写入必须走显式 CLI 命令。
- Worker 使用独立消息上下文，只能列目录、读文本、限额搜索和提交有来源的短回执。项目文件按行范围读取；不开放 shell、写文件、任意 URL 或递归委托。它是应用层文件边界，不是操作系统沙箱。
- 每次用户请求最多一个 Worker；Lead 最多 4 次调用，Worker 每 attempt 最多 6 次；Worker 搜索最多 200 个文件、8 MiB 和 60 个命中，目录深度最多 20 层。单次读最多 200 行/6000 码点，累计 18000 码点。
- 画像注入 ≤1600 码点；Lead 历史 ≤6000，用户输入 ≤4000，资料/回执 ≤1000，单次字符装配保护值 ≤16000。模型 usage 若未返回则保持未知；token 预算不是精确费用保证。
- 容量上限：明确记忆 10000 事件/32 MiB；元数据 100000 事件/64 MiB；usage 16 MiB。超限会停止新写入或停止记录 usage，不自动删除和压缩历史。
- 重启时未完成的 running 任务转为 `unknown`，不会自动重跑。显式 `/retry` 会创建新 attempt。Worker 报告只标 `reported_success`，没有通用 `verified_success`。
- 同一操作系统账户可以直接访问底层文件；本程序不提供多用户认证。不要将数据 root 放在多人可写目录。
- 文档范围、代码模块与测试对应关系见本地 `docs/IMPLEMENTATION-TRACEABILITY.md`（`docs/` 不入库）。真实模型调用、费用统计、DSH 宿主能力及外部记忆 provider 尚未以真实服务验收。
