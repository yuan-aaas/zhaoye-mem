# 照夜 zhaoye · 开发设计文档

> **版本**：v1.0 · 2026-10-26 · **状态**：🟢 可开工
> **上位文档**：[ARCHITECTURE.md](ARCHITECTURE.md)（v2.1）—— 不变量、数据根布局、事件闭集、预算常量的唯一真源，本文不复述
> **变更依据**：[adr/0001-multi-adapter-packaging.md](adr/0001-multi-adapter-packaging.md)
> **读者**：实现者与接手者。本文只写「做什么、长什么样、怎么验」，不重复论证。

---

## 0. 一页纸

| 项 | 结论 |
|---|---|
| 产品形态 | 插件是门，`~/.zhaoye` 是身体；换工具还是同一个助理 |
| 交付形态 | 单仓多包（8 包）；用户只装插件；发布时 core bundle 进插件 |
| 第一版能做 | 装 DSH 插件 → 首次自动建数据根 → 注入人格/画像/记忆 → 显式记一条 → 重开仍在 → 单活 presence 有文案 |
| 第一版不做 | daemon、多工具同时写、向量检索、Web UI、自动记忆提取（ARCHITECTURE §16） |
| 总验收 | `pnpm verify` 全绿 + M4 十项逐条签收 |

---

## 1. 范围与判据

### 1.1 做

1. 可验证的存储内核（日志 + 提交序列器 + presence）。
2. 版本化画像、显式记忆、路由查询。
3. 唯一门面 `AssistantService` 与唯一组合根 `createZhaoye`。
4. DSH 真机插件；MCP 与 CLI 作为第二、第三入口。
5. 首次运行守护式创建数据根；旧数据根迁移（dry-run 先行）。

### 1.2 不做

见 ARCHITECTURE §16。一句话：先把「数据不坏 + 显式写入 + 可携带」做对，不做 UI、不做并发写、不做模型。

### 1.3 成功判据

| # | 判据 | 验证方式 |
|---|---|---|
| 1 | 任何写都只有一个入口 | 架构测试：除 `storage` 外无 `writeFile/appendFile` |
| 2 | 删掉 `projections/` 后重放结果逐字节一致 | 集成测试 `rebuild-equivalence` |
| 3 | 两个进程同时 open，第二个拿到带 owner 的错误 | 跨进程测试（两次 node 调用） |
| 4 | 画像指针被篡改后自动修复并审计 | 失败注入 `identity-pointer-drift` |
| 5 | 预算超限必然在发送模型前失败 | 契约测试 `budget-assert` |
| 6 | 新宿主只加一个 `plugins/<host>/` | `verify` + conformance 套件 |
| 7 | 首次装插件不产生第二个数据根 | `init-guard` 用例 |

---

## 2. 仓库与包

### 2.1 目录

```text
zhaoye/
├─ package.json                 # 私有根包：workspaces + scripts + 固定 packageManager
├─ pnpm-lock.yaml               # 唯一依赖锁文件，提交入库
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ biome.json
├─ .gitignore                    # node_modules、dist、dist-test、tests-dist、tsbuildinfo
├─ .dependency-cruiser.cjs
├─ scripts/
│  ├─ run-tests.mjs             # 逐个 import 测试文件（不 spawn）
│  └─ verify.ps1                # 沙箱内 pnpm 不可用时的兜底
├─ packages/
│  ├─ contracts/
│  ├─ storage/
│  ├─ core/
│  ├─ app/
│  ├─ adapter-kit/
│  └─ cli/
├─ plugins/
│  ├─ dsh/
│  └─ mcp/
├─ tests/
│  ├─ tsconfig.json              # 根级测试独立编译，不作为 workspace 包
│  ├─ adapter-conformance/
│  └─ integration/
├─ presets/                     # kernel / persona 模板
└─ docs/
```

### 2.2 包规格

| 包 | 发布名 | 职责 | 公开面 | 允许依赖 |
|---|---|---|---|---|
| `packages/contracts` | `@zhaoye/contracts` | zod schema、类型、错误码、预算常量、事件闭集 | 全部 | `zod` |
| `packages/storage` | `@zhaoye/storage` | journal、sequencer、presence、atomic-fs、projection 存储 | `openJournal` / `createSequencer` / `createPresence` / `atomicWrite` / `ensureDataRoot` | contracts、`node:*` |
| `packages/core` | `@zhaoye/core` | identity / memory / index | `createIdentityService` / `createMemoryService` / `createRouteIndex` | contracts、storage |
| `packages/app` | `@zhaoye/app` | `AssistantService`、组合根、任务账本、预算、维护 | `createZhaoye`、门面类型 | contracts、core |
| `packages/adapter-kit` | `@zhaoye/adapter-kit` | prompt 装配、receipt 校验、notice 渲染、project 映射、persona、tool-schema | 上述六个函数 | contracts |
| `packages/cli` | `@zhaoye/cli` | `bin: zhaoye`，init / doctor / presence / migrate / export | `run(argv)` | contracts、app、adapter-kit |
| `plugins/dsh` | `dsh-plugin-zhaoye` | DSH 生命周期、工具注册、能力探测、`DshSessionWorker` | `register(ctx)` | app、adapter-kit、contracts + 宿主 SDK |
| `plugins/mcp` | `@zhaoye/mcp` | MCP tools / resources | `createMcpServer()` | app、adapter-kit、contracts + MCP SDK |

**硬规则**

1. `packages/*` 不发布；只有 `plugins/*` 是用户安装物。
2. 插件只能 import 公开入口，不得 import 其他插件。
3. `internal/` 只在包内可见。
4. `app` 只依赖 `core + contracts`，不依赖 `adapter-kit` 或具体适配器；`core` 不碰文件系统模块。

### 2.3 依赖规则（可执行）

规则以生产源码为边界（`packages/*/src`、`plugins/*/src`），不把测试依赖算作生产依赖：

| 规则 | 来源 | 禁止目标 / 约束 |
|---|---|---|
| contracts-pure | `packages/contracts/src` | 只允许 contracts 自身与 zod；禁止 Node 内建模块 |
| storage-no-domain | `packages/storage/src` | 禁止依赖 core/app/adapter-kit/cli/plugins |
| core-no-fs | `packages/core/src` | 禁止 `fs`、`path`、`os`、`child_process` 的 `node:` 和裸导入形式 |
| core-no-upper | `packages/core/src` | 禁止依赖 app/adapter-kit/cli/plugins |
| app-no-adapters | `packages/app/src` | 禁止依赖 adapter-kit/cli/plugins；app 仅依赖 core + contracts |
| kit-pure | `packages/adapter-kit/src` | 只依赖 contracts，不依赖 node 内建模块或更高层 |
| plugin-public-only | 每个 `plugins/<name>/src` | 允许本插件、app/adapter-kit/contracts 公开入口、已声明宿主 SDK 和 node 内建模块；禁止其他插件 |
| no-cross-internal | 各包源码 | 禁止跨包导入另一包的 `src/internal/`；包内可用自己的 internal |
| no-circular | 全部生产源码 | 禁止循环依赖 |

`.dependency-cruiser.cjs` 从明确的包名清单生成逐插件边界规则和逐包 internal 规则。不得假定 `from.path` 捕获组会插值到 `to.path`。依赖扫描输入限定到生产源码。验收包含宿主 SDK/同包 internal 导入正例，以及跨插件/跨包 internal/越层依赖反例。报错必须包含「谁 → 谁」，例如 `storage-no-domain: packages/storage/src/journal/append.ts → packages/core/src/identity`。

### 2.4 版本与发布

- 根 `package.json` 的 `version` 是版本唯一来源；8 个包清单保留同值版本字段，`check-versions.mjs` 对照根版本逐包断言，不在构建时隐式注入。
- `pnpm publish:plugins` 流程：`build` → 每个插件 `esbuild --bundle --platform=node` → 检查产物里不含 `@zhaoye/*` 的裸导入 → 发布。
- 每个发布物写入 `build-info.json`：`{ version, commit, built_at, data_schema: 3 }`。

根包声明 `packageManager: "pnpm@<固定版本>"`，`pnpm-lock.yaml` 入库。`pnpm-workspace.yaml` 只匹配 `packages/*` 与 `plugins/*`；根级 `tests/` 通过根测试配置编译，不是 workspace package。README 的安装命令使用 `pnpm install --frozen-lockfile`，并写明 Node/pnpm 前置版本与 `pnpm verify`。`packages/cli` 在 T0 是内部 CLI 入口；在交付用户可安装 CLI 前，须另行确定发布形态并记录 ADR，避免与“packages 不发布”的策略冲突。

---

## 3. 接口契约

### 3.1 门面

```ts
export interface AssistantService {
  // 画像
  readIdentity(ctx: ActorContext): Promise<IdentitySnapshot>;
  previewIdentityUpdate(req: IdentityUpdateRequest, ctx: ActorContext): Promise<IdentityProposal>;
  commitIdentityUpdate(proposalId: string, expectedRevision: number, ctx: ActorContext): Promise<IdentityCommit>;
  // 记忆
  locate(ctx: QueryContext): Promise<LocateResult>;
  list(ctx: QueryContext): Promise<LocateResult>;
  recall(recordId: string, ctx: QueryContext): Promise<MemoryItem>;
  remember(intent: WriteIntent, input: RememberInput): Promise<CommitReceipt & { recordId: string }>;
  replace(intent: WriteIntent, recordId: string, expectedRevision: number, input: ReplaceInput): Promise<CommitReceipt>;
  archive(intent: WriteIntent, recordId: string, expectedRevision: number): Promise<CommitReceipt>;
  // 运行态
  presence(): Promise<OwnerInfo | null>;
  doctor(): Promise<DoctorReport>;
  close(): Promise<void>;
}
```

### 3.2 组合根

```ts
export interface ZhaoyeConfig {
  dataRoot: string;            // 默认 resolveDataRoot() → ~/.zhaoye
  host: AdapterManifest;
  idleTimeoutMs?: number;      // 默认 900_000；0 = 关闭
  clock?: ClockPort;
  model?: ModelPort;
  worker?: WorkerPort;
  notifier?: HostPort;
}

export async function createZhaoye(cfg: ZhaoyeConfig): Promise<Zhaoye>;
```

`createZhaoye` 是全仓唯一 `new` 具体实现的地方；适配器只拿到 `AssistantService`。

### 3.3 端口

```ts
export interface ClockPort { now(): Date }
export interface ModelPort { complete(req: ModelRequest): Promise<ModelResponse> }
export interface WorkerPort {
  start(packet: TaskPacket): Promise<{ taskId: string; handle: string }>;
  inspect(handle: string): Promise<WorkerStatus>;
  cancel(handle: string): Promise<void>;
  close?(): Promise<void>;
}
export interface SourcePort { list(): Promise<SourceItem[]>; read(id: string): Promise<SourceContent> }
export interface HostPort { notify(notice: Notice): Promise<void>; openPath?(path: string): Promise<void> }
```

### 3.4 错误

```ts
export interface AssistantError {
  code: ErrorCode;
  message: string;
  retry: 'never' | 'safe' | 'after_reconcile';
  action?: 'run_doctor' | 'release_presence' | 'takeover' | 'retry_later' | 'reinit' | 'restore_backup';
  details?: unknown;
}
```

新增码 `ASSISTANT_SAME_PROCESS`：同一宿主进程内重复 open（同 pid、不同 `instance_id`），`action: 'release_presence'`。

### 3.5 AdapterManifest

```ts
export type Capability = 'tools' | 'prompt' | 'session' | 'approval' | 'notice' | 'worker';

export interface AdapterManifest {
  host_id: string;              // 'dsh' | 'mcp' | 'cli'
  display_name: string;
  capabilities: Capability[];
  min_data_schema: 3;
  adapter_version: string;
}
```

启动时比对 `manifest.schema_version`：低于 `min_data_schema` → `SCHEMA_MIGRATION_REQUIRED`；高于支持上限 → 同样拒绝，不许读。

---

## 4. 数据根与生命周期

### 4.1 布局

以 ARCHITECTURE §5.1 为准。实现只允许通过 `storage` 访问，`core` 不碰路径。

### 4.2 首次运行：守护式创建

| 打开时的状态 | 行为 |
|---|---|
| 路径不存在或空目录 | 允许 init：写 `manifest.json` + 空 `journal/`，并**显式告知**「已在 X 创建新的照夜数据根」，写 audit |
| 有 v3 manifest + 日志 | 正常 open |
| 有 v2 manifest | `SCHEMA_MIGRATION_REQUIRED`，提示 migrate，不自动升 |
| 有数据痕迹但缺 manifest / 日志为空 | `CORRUPT_DATA`，**绝不**初始化为空库 |
| 父目录不可写或不存在 | 报带 `action` 的错误，不改用其他路径 |
| 第二个宿主打开已存在的根 | 直接接入；被占用则 `ASSISTANT_PRESENT_ELSEWHERE` |

创建 `manifest.json` 必须 `tmp → rename → fsync`；Windows 按 `%USERPROFILE%` 解析 home；路径先 `resolve` 再做前缀校验。

### 4.3 presence

状态机见 ARCHITECTURE §6.3。实现要点：

1. `owner.json` 增加 `instance_id`（每次 open 生成 uuid v7）。
2. 同 pid + 同 instance → 返回原句柄（幂等），不写第二次 `presence.entered`。
3. 同 pid + 不同 instance → `ASSISTANT_SAME_PROCESS`，文案提示「同一宿主进程内已有照夜实例」。
4. handoff：插件提供「让照夜离开」→ `release()` → append `presence.released` → 删 owner 与锁目录；下一个门再 acquire。
5. 空闲超时：每 60s 心跳，记录 `last_commit_at`；超时且任务账本无 `created/dispatched/running` → `release` + `presence.released{reason:'idle_timeout'}`。
6. 活进程永不自动抢占；强制接管只能显式 `--force` + 备份 + 审计。

---

## 5. 适配器

### 5.1 能力矩阵

| 能力 | DSH | MCP | CLI |
|---|---|---|---|
| 工具注册 | ✅ | ✅ | ✅ |
| 提示注入 | ✅ 全量 | instructions 文本 | 每轮传入 |
| 会话/子代理 | ✅ | ❌ | ❌ |
| 审批 | ✅ `ask` | ❌ | 终端确认 |
| 工作轨 | 原生会话 | ❌ 不伪装 | 本地只读 Worker |

### 5.2 DSH 插件

- 入口：`register(ctx: DshPluginContext)`；`ctx` 的宿主字段全部集中在本包 `src/host.ts`，**单点适配**宿主 API。
- 工具面：`assistant_locate` / `assistant_recall` / `assistant_remember` / `assistant_replace` / `assistant_archive` / `assistant_identity_read` / `assistant_identity_preview` / `assistant_identity_commit` / `assistant_presence` / `assistant_doctor`。
- 参数 schema 由 `adapter-kit/tool-schema` 从 contracts 生成，不手写第二份。
- 会话开始：装配 persona + identity + L1/L2，固定注入 ≤2800 码点；装配函数与 CLI 共用。
- 打开失败原样上抛（带 `action`），不吞成「记忆不可用」。

### 5.3 MCP

- 独立进程；`tools` 暴露上述 `assistant_*`，`resources` 提供 `zhaoye://identity/current`、`zhaoye://memory/recent`。
- 无会话、无审批：明确声明 `capabilities: ['tools','prompt']`，不伪装工作轨。

### 5.4 CLI

| 命令 | 阶段 | 行为 |
|---|---|---|
| `zhaoye init` | M1 | 显式初始化数据根（与自动 init 同一套校验） |
| `zhaoye doctor` | M1 | 只读诊断：manifest、段清单、hash 链、投影、presence |
| `zhaoye presence` | M1 | 显示 owner；`release` 让出；`takeover --force` 强制接管（先备份） |
| `zhaoye migrate --dry-run` | M3 | 只读扫描 + 报告，不写 |
| `zhaoye export` | M5 | 导出可读投影（Markdown + JSON） |

### 5.5 conformance 套件（新插件必须全过）

| # | 断言 | 失败即不落地 |
|---|---|---|
| 1 | 只 import 公开入口，不碰 `src/` | depcruise |
| 2 | 工具 schema 与 contracts 生成结果逐字节相等 | 快照比对 |
| 3 | 错误带 `action` 透传，不吞异常 | 注入假错误 |
| 4 | 回执走 adapter-kit 提取/截断/证据校验 | 超长 summary 截断且 `truncated:true` |
| 5 | 能力探测失败 → 显式能力缺失 | 假宿主返回不支持 |
| 6 | 归属校验：跨门提交 → `UNAUTHORIZED` | 双 adapter 集成 |
| 7 | presence 生命周期：enter / release / 崩溃恢复 | 假时钟 |
| 8 | 不静默成功：失败不返回成功值 | 失败注入 |

---

## 6. 工程

### 6.1 根配置

```json
{
  "name": "zhaoye",
  "version": "<根版本>",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@<固定版本>",
  "engines": { "node": ">=24 <25" },
  "scripts": {
    "build": "pnpm -r run build && tsc -p tests/tsconfig.json",
    "typecheck": "pnpm -r run typecheck",
    "lint": "biome check .",
    "arch": "depcruise --config .dependency-cruiser.cjs packages plugins",
    "test": "node scripts/run-tests.mjs",
    "check:versions": "node scripts/check-versions.mjs",
    "verify": "pnpm check:versions && pnpm build && pnpm typecheck && pnpm lint && pnpm arch && pnpm test"
  }
}
```

`<根版本>` 和 `<固定版本>` 都是文档占位符，落地时分别替换成项目版本和创建仓库时选定的 pnpm 版本。`build` 先按 workspace 依赖顺序生成包源码与包内测试产物，再编译根级测试；`typecheck` 逐包检查源码和测试配置，`test` 因而能解析到包的公开构建入口。根 `test` 统一运行包内与根级测试，不依赖 workspace 递归发现根级 `tests/`。

### 6.2 tsconfig 基线

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

共享基线不设置 `rootDir` / `outDir`。每个包使用 `tsconfig.build.json`（`rootDir: "src"`、`outDir: "dist"`、只含源码）和 `tsconfig.test.json`（`rootDir: "test"`、`outDir: "dist-test"`、只含 `test/`）；根级 `tests/tsconfig.json`（`rootDir: "."`、`outDir: "../tests-dist"`）单独编译 `tests/`。包内 `build` 编译源码和测试，`typecheck` 对两者执行 no-emit 检查。测试通过包的公开入口导入已构建产物，不把包测试混进源码构建。

### 6.3 测试执行

- 包内测试编译到 `packages/*/dist-test/`；根级测试编译到 `tests-dist/`。`scripts/run-tests.mjs` 只扫描 `packages/*/dist-test/**/*.test.js` 与 `tests-dist/**/*.test.js`，逐个 `await import()` 测试文件，不 spawn 子进程（Windows 沙箱下 `node --test` 批量模式会 spawn EPERM）。
- `run-tests.mjs` 在编译产物缺失时以非零状态退出，并报告缺失路径；不把“没有发现测试”当作成功。
- 集成测试用独立进程时，由 PowerShell 直接两次调用 `node`，不用 `child_process` 管道。

### 6.4 测试金字塔

| 层 | 内容 | 位置 |
|---|---|---|
| 契约 | schema 闭集、golden JSON、工具 schema 一致 | `packages/contracts/test` |
| 单元 | sequencer / journal / identity / memory / index | 各包 `test/` |
| 失败注入 | 撕尾、中段损坏、缺日志、并发提交、锁竞争、预算溢出、rename 失败 | `packages/storage/test/failure` |
| 集成 | `createZhaoye` + 假端口 + 临时数据根 | `tests/integration` |
| 适配器 | 假宿主 + conformance 套件 | `tests/adapter-conformance` |
| 架构 | depcruise + 扫描 `storage` 外的文件写 | `pnpm arch` |

### 6.5 Windows 约束

- 路径含中文必须有一条 fixtures 用例。
- `rename` 覆盖语义、目录 fsync、锁目录 rename 各一条测试。
- 沙箱内若 `pnpm -r` 因 spawn EPERM 失败，改用 `scripts/verify.ps1`；脚本先确认依赖已安装并运行版本一致性检查，再按依赖拓扑逐包调用本地 `tsc.cmd` / `node.exe`，不经 pnpm 转发，并执行根级测试编译与 runner。

---

## 7. 里程碑

### T0 骨架（预计 1–2 天）

- [ ] 根配置、固定 `packageManager`、`pnpm-lock.yaml`、README 安装/验证说明
- [ ] `.gitignore` 忽略 `node_modules/`、`**/dist/`、`**/dist-test/`、`tests-dist/`、`*.tsbuildinfo`
- [ ] `pnpm-workspace.yaml` 仅包含 `packages/*` 与 `plugins/*`
- [ ] 8 个包：`package.json` / `tsconfig.build.json` / `tsconfig.test.json` / `src/index.ts` 占位 / `test/smoke.test.ts`
- [ ] 根级 `tests/tsconfig.json` 与测试产物发现规则
- [ ] `contracts` 落 `EventEnvelope` 真 schema 一条，其余留骨架
- [ ] `scripts/run-tests.mjs`、`scripts/verify.ps1`
- [ ] depcruise 能拦住跨插件、跨包 internal、越层依赖；宿主 SDK 和包内测试正例不误报

**DoD**：从无 `dist/` 的干净检出按 README 安装后，`pnpm verify` 退出码 0；故意越界 import 报错且信息可指导修复；允许的宿主 SDK 导入通过；没有测试产物时 runner 明确失败。

### M1 存储内核

- [ ] `atomic-fs` / `journal` / `sequencer` / `presence` / `projections`
- [ ] 失败注入：撕尾、中段损坏、缺日志、seq 跳号、并发 submit、锁竞争、rename 失败
- [ ] CLI：`init` / `doctor` / `presence`

**DoD**：ARCHITECTURE §5.3 全部案例绿；第二写者带 owner 报错；活锁不被清；10k 事件 open ≤300ms。

### M2 记忆核心

- [ ] identity：propose / apply / materialize / verify
- [ ] memory：record / revise / archive / query
- [ ] index：fold / route-index / rebuild
- [ ] budgets：唯一常量 + 唯一断言点

**DoD**：10k 路由 `locate` ≤50ms p95；locate B → recall B；无每轮全链校验。

### M3 门面与端口

- [ ] `AssistantService` + `createZhaoye`
- [ ] TaskLedger 状态机 + created 恢复
- [ ] `migrate --dry-run`
- [ ] CLI `migrate`

**DoD**：架构测试断言无 `new` 核心；CLI 命令全绿；`created/dispatched` 重启后可 retry/cancel。

### M4 DSH 真机

- [ ] `plugins/dsh` 接真实宿主 API（`host.ts` 单点）
- [ ] 工具面 + 会话开始注入
- [ ] persona 联动（off/auto/on）
- [ ] conformance 套件全绿
- [ ] 十项验收逐条签收

**DoD**：十项全部通过；未过项写明限制与替代路径。

### M5 外部来源与运维

- [ ] `SourcePort` + 第一个真实来源
- [ ] 导出 / 压缩 / 容量预警
- [ ] `plugins/mcp` 落地（tools + resources）
- [ ] MCP conformance 全绿

**DoD**：导入 → 召回端到端；重复导入不重复建记录。

---

## 8. 风险

| 风险 | 信号 | 缓解 |
|---|---|---|
| 多包退化成多份复制 | 插件里出现业务判断 | depcruise + conformance + 评审 |
| 宿主 API 漂移 | 升级后工具面静默变化 | `host.ts` 单点 + M4 真机验收清单 |
| 构建顺序错乱 | 局部 build 通过、全量失败 | `pnpm -r` 拓扑 + CI 全量 verify |
| 自动建根造出空库 | 第二个 `~/.zhaoye` 出现 | init 守护表（§4.2）+ 用例 |
| 空闲超时误释放 | 长任务被踢 | 只在无进行中任务时释放 + 审计 |
| 文档再次脱节 | 代码改了文档没改 | 同提交更新 + ADR 门槛 |

---

## 9. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-10-26 | 首版：单仓多包、8 包规格、接口签名、init 守护、presence handoff、里程碑与 DoD |
