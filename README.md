# 照夜 · Zhaoye

照夜是运行在 DeepSeek Harness（DSH）里的个人助理。它在本地保存协作偏好、记忆备份和个人资产，帮你查过去的工作、找项目资料，也可以把任务派给独立的工作会话。

## 可以做什么

- **记住长期偏好。** 在照夜会话里说「以后读不到文件，先问我要路径或权限」。明确的偏好会写入画像，照夜返回画像版本，方便核对。
- **查证过去的工作。** 用已授权的记忆工具按日期和关键词查询，也可以从已登记的个人资产库读取日报、周报和项目资料。
- **增量同步 Mneme。** 照夜只读对账，保存新增、修改和可见性变化。周五可在对话中收到同步提醒，由你决定何时执行。同步得到的偏好有待确认入口。
- **使用个人资产库技能。** 左侧栏的「照夜」可以检查数据目录、查看资产库中待安装的技能，并直接创建一条照夜会话。

## 在 DSH 试用

试用版本在 `codex/persona-context-optimization` 分支。需要 **DSH 0.2.2-rc.5 或以上**、**Node.js 24.x** 和 **pnpm 11.7.0**。以下命令在 PowerShell 中运行。

```powershell
git clone --branch codex/persona-context-optimization https://github.com/yuan-aaas/zhaoye-mem.git
Set-Location zhaoye-mem
pnpm install --frozen-lockfile
pnpm build

$pluginPath = (Resolve-Path ./plugins/dsh).Path.Replace('\', '/')
dsh plugin --profile desktop add "link:$pluginPath"
```

重启 DSH，在左侧栏打开「照夜」。选择已有的照夜数据根，或选择空目录并初始化。目录就绪后，点击「开始对话」会新建会话并选中照夜预设，模型沿用 DSH 的默认设置。使用其他 DSH profile 时，把命令中的 `desktop` 换成相应名称。

## 本地数据

```text
<数据根>/
  identity/     人格画像、长期偏好与版本记录
  backup/       SQLite 记忆备份、增量批次与同步状态
  assets/       个人资产清单及 files/ 下的原件
```

迁移时复制整个数据根，然后在照夜弹窗中选中迁移后的目录。照夜空闲时会即时切换。Mneme 源库路径发生变化后，重新登记来源。

如果要接入个人配置包，把它放到 `assets/files/<资产 ID>/`。命令行登记资产后，照夜可以按路径检索对应原件。技能可从弹窗逐项安装到 DSH。

## 命令行

在仓库根目录构建后可运行以下命令。请把示例目录换成自己的绝对路径。

```powershell
$dataRoot = 'D:/example/zhaoye'
node ./packages/cli/dist/bin.js init --data-root $dataRoot
node ./packages/cli/dist/bin.js doctor --data-root $dataRoot
node ./packages/cli/dist/bin.js identity history --data-root $dataRoot
node ./packages/cli/dist/bin.js preference list --data-root $dataRoot
```

登记已放到 `assets/files/` 下的配置包时，用目录名作为资产 ID。Mneme 来源登记时指定 SQLite 文件，可通过 `--policy` 选择授权范围。登记后用返回的 `sourceId` 发起增量同步。

```powershell
node ./packages/cli/dist/bin.js assets register-config-bundle example-bundle --data-root $dataRoot
node ./packages/cli/dist/bin.js backup source add --file 'D:/example/memory.db' --data-root $dataRoot
node ./packages/cli/dist/bin.js backup sync --source '<sourceId>' --data-root $dataRoot
```

命令行登记或同步需要取得数据根的写入锁。DSH 正在使用同一目录时，可以在照夜会话里说「同步记忆」，再按提示确认。

## 开发验证

```powershell
pnpm verify
```

验证涵盖构建、类型检查、包依赖边界、功能测试以及 Windows 跨进程与权限检查。在 Windows 上也可以运行 `pwsh ./scripts/verify.ps1`。DSH 插件位于 `plugins/dsh/`，命令行入口位于 `packages/cli/`。
