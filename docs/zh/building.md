# 构建 Amira

[English](../building.md) · [日本語](../ja/building.md) · [文档首页](../../README.zh-CN.md)

在本仓库的本地副本中使用 Bun **1.4.2**：

```sh
bun install --frozen-lockfile
bun run build                       # Current platform and architecture
bun run build --target bun-windows-x64
bun run build:all                   # All seven targets
bun run build:all --version 0.1.0-nightly.20261011 --channel next
```

默认版本取自 `packages/cli/package.json`，可用 `--version` 覆盖。默认渠道为 `stable`，可用 `--channel stable|next` 覆盖。Bun 可以在一台机器上交叉编译全部目标，必要时会下载对应的 Bun 运行时。

| 目标 | 压缩包 |
| --- | --- |
| `bun-windows-x64` | `.zip` |
| `bun-windows-x64-baseline` | `.zip` |
| `bun-linux-x64` | `.tar.gz` |
| `bun-linux-x64-baseline` | `.tar.gz` |
| `bun-linux-arm64` | `.tar.gz` |
| `bun-darwin-x64` | `.tar.gz` |
| `bun-darwin-arm64` | `.tar.gz` |

x64 baseline 目标适用于不支持 AVX2 的较旧 CPU。可执行文件输出到 `dist/amira-<target>/amira`（Windows 下为 `amira.exe`），压缩包为 `dist/amira-<target>.zip` 或 `.tar.gz`。`dist/SHA256SUMS` 包含压缩包的 SHA-256 校验值。`dist/` 已被 Git 忽略。

单文件可执行程序包含 Bun 运行时、内置资源和 Worker 入口，运行时不需要另行安装 Bun。它支持从磁盘加载外部 TypeScript 扩展，但不支持包含 JSX 的扩展。

## 检查构建结果

在操作系统和架构与目标一致的机器上执行：

```sh
./dist/amira-bun-linux-x64/amira --version
./dist/amira-bun-linux-x64/amira --self-check
```

Windows 下使用 `dist/amira-bun-windows-x64/amira.exe`。`--version` 输出版本、渠道和目标。隐藏的 `--self-check` 输出 JSON；如果 Worker 没有发出 `ready`（包括退回到主线程执行的情况）、无法读取内置主题，或 Windows Job Object 不可用，则以非零状态退出。它不需要 provider 凭据，也不会调用真实 API。

## CI 与 nightly

CI 在推送到 `main` 和提交 pull request 时运行，使用 Ubuntu、Windows 和 macOS runner，以及 Bun 1.4.2。每个 runner 按冻结的 lockfile 安装依赖，执行 `bun run check`（架构检查、类型检查、lint 和测试），再构建本机目标的可执行文件并进行冒烟测试。测试使用仓库提供的隔离测试主目录，不启用真实 API 测试。

Nightly 工作流每天 **UTC 18:00** 运行，也可在 GitHub Actions 中手动触发。如果 `main` 自上一个 nightly 以来没有新提交，则跳过。三个平台通过相同检查后，由一个 runner 交叉编译全部七个目标，渠道为 `next`。独立的本机 runner 校验并解压压缩包，在不安装 Bun 的情况下对 Windows x64、Linux x64（两者均包含 baseline）和 macOS ARM64 进行冒烟测试。由于 `macos-13` 已于 2025 年 12 月退役，macOS x64 冒烟测试被跳过；当前工作流也没有 Linux ARM64 本机冒烟 runner。

Nightly 可从 [GitHub Releases](https://github.com/CAMB-dev/Amira/releases) 下载。它们是标签为 `v<X.Y.Z>-nightly.<YYYYMMDD>` 的预发布版本；标签已存在时追加数字后缀。基础版本会去掉 CLI 源码版本中的 RC 后缀：`1.2.3-rc.1` 仍会生成 `v1.2.3-nightly.<YYYYMMDD>`，因此发现已有版本和执行保留策略时使用相同的标签格式。发布说明列出自上一个 nightly 以来的提交。每次发布包含全部压缩包和 `SHA256SUMS`：先将资源上传到草稿，再正式发布，已发布版本不会被覆盖或修改。仅保留最新的 **14 个 nightly 预发布版本**，更早的 nightly 及其标签会被删除，非 nightly 版本不受影响。

## 稳定版标签发布与 npm

标签发布工作流增加了签名 manifest 和分平台的 npm 包。支持的平台、验证方法和维护者检查清单见[安装与发布配置](install.md)。Nightly 工作流仍然只提供压缩包。安装脚本和 `amira update` 留待后续批次实现。

执行 `build:all` 后，为全部五个平台包和启动器生成暂存目录：

```sh
bun scripts/npm-pack.ts
cd dist/npm/amira
npm pack --dry-run --ignore-scripts
```

进行本地打包冒烟测试时，先构建对应的 npm 目标（x64 平台使用 `bun-windows-x64-baseline` 或 `bun-linux-x64-baseline`），再将该目标传给 `bun scripts/npm-pack.ts --target <target>`。暂存过程从 `dist/build.json` 读取版本、渠道和目标，因此不会悄悄包含先前构建留下的旧二进制文件。生成的包包含 LICENSE 和必须保留的 NOTICE 归属声明。暂存过程仅替换生成的 `dist/npm/` 子目录，不会发布任何内容。
