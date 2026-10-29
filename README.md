# 照夜 zhaoye

照夜是外部管理与编排框架：主助手使用人格记忆、本地全量记忆备份和个人资产；工作 Agent 继续使用原记忆系统，照夜只读备份，不写回。

当前处于 **T0 工程骨架已完成**：单仓多包、契约、编译/测试/架构检查均已落地；三类数据域、只读备份导入和 AI 工具编排仍属后续实现。

## 环境

- Node.js 24.x（`>=24 <25`）
- pnpm 11.7.0（根 `packageManager` 固定）

## 安装与验证

```powershell
pnpm install --frozen-lockfile
pnpm verify
```

`verify` 依次执行：包版本一致性 → 构建源码与测试 → 类型检查 → Biome → dependency-cruiser → 全部测试。

沙箱或受限 Windows 环境下 `pnpm -r` 可能因 spawn EPERM 失败，此时使用等价兜底脚本（按依赖拓扑直接调用本地 `tsc`/`node`）：

```powershell
pwsh ./scripts/verify.ps1
```

## 仓库结构

```text
packages/
  contracts/      # zod schema、错误码、端口、预算、事件闭集
  storage/        # journal / sequencer / presence / atomic-fs
  core/           # identity / memory / index
  app/            # AssistantService、组合根、任务账本
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

- [外部管理框架与记忆核心设计](docs/外部管理框架与记忆核心设计.md)（当前设计真源）
- [记忆核心开发设计与任务划分](docs/记忆核心开发设计.md)（开发拆分与验收基线）
- [架构设计](docs/架构设计.md)
- [开发设计与里程碑](docs/开发设计与里程碑.md)
- [工程骨架与业务填充路线](docs/工程骨架与业务填充路线.md)
- [决策记录 0001：单仓多包与多适配器发布](docs/决策记录/0001-单仓多包与多适配器发布.md)
