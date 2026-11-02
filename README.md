# 照夜 zhaoye

照夜是外部管理与编排框架：主助手使用人格记忆、本地全量记忆备份和个人资产；工作 Agent 继续使用原记忆系统，照夜只读备份，不写回。

当前已落地 **M1 契约与人格记忆**：数据根、人格读写/预览/回滚、CAS/幂等、版本、presence 单活、诊断和 CLI。验收记录见 [工程与里程碑](docs/02-工程与里程碑.md)。SQLite 备份、导入检索、资产库与 DSH/MCP 接入仍在 M2–M5。

## 环境

- Node.js 24.x（`>=24 <25`）
- pnpm 11.7.0（根 `packageManager` 固定）

## 安装与验证

```powershell
pnpm install --frozen-lockfile
pnpm verify
```

`verify` 依次执行：包版本一致性 → 构建源码与测试 → 类型检查 → Biome → dependency-cruiser → 功能测试 → PowerShell 跨进程与 Windows ACL 验收。

沙箱或受限 Windows 环境下 `pnpm -r` 可能因 spawn EPERM 失败，此时使用等价兜底脚本（按依赖拓扑直接调用本地 `tsc`/`node`）：

```powershell
pwsh ./scripts/verify.ps1
```

## 仓库结构

```text
packages/
  contracts/      # 严格 schema、错误码、端口、预算、默认值
  storage/        # atomic-fs / data-root / identity-store / presence
  core/           # 身份领域服务与确定性 Markdown 投影
  app/            # 唯一组合根、门面、doctor、生命周期
  adapter-kit/    # prompt / receipt / notice / persona / tool-schema
  cli/            # bin: zhaoye
plugins/
  dsh/            # dsh-plugin-zhaoye
  mcp/            # @zhaoye/mcp
tests/            # 根级集成与适配器一致性测试（非 workspace 包）
presets/          # kernel / persona 模板
docs/             # 架构、开发设计、ADR
scripts/          # verify / run-tests / check-versions
```

包与包之间只通过公开入口和 workspace 协议依赖；边界由 `.dependency-cruiser.cjs` 强制检查。

## 文档

入口：[docs/README.md](docs/README.md)（文档地图与维护规则）。
- [01 架构基线](docs/01-架构基线.md)：定位、三域、边界、不变量（当前设计真源）
- [02 工程与里程碑](docs/02-工程与里程碑.md)：实测状态、包职责、M1–M5 路线
- [03 记忆核心技术设计](docs/03-记忆核心技术设计.md)：契约、数据模型、端口、错误、验收
- [04 M1 契约与人格记忆开发设计](docs/04-M1-契约与人格记忆开发设计.md)：阶段设计与实施偏差
- [M1 执行计划](docs/M1-执行计划.md)：开发顺序与验收记录
- 决策记录：[0001 单仓多包](docs/决策记录/0001-单仓多包与多适配器发布.md)、[0002 替代全局事件日志](docs/决策记录/0002-以SQLite备份库替代全局事件日志.md)
