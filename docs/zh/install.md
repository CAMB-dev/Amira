# 安装

[English](../install.md) · [日本語](../ja/install.md) · [文档首页](../../README.zh-CN.md)

## 包管理器

任选一种：

```sh
npm i -g amira
pnpm add -g amira
bun add -g amira
```

npm 和 pnpm 的启动器需要 Node.js **18 或更新版本**。可执行文件自带运行时，因此不需要安装 Bun。必须启用可选依赖：它们包含适用于当前平台的可执行文件。支持 Windows x64、Linux x64/ARM64（glibc）和 macOS x64/ARM64。这些包不支持 Linux musl。

`amira` 包包含一个小型启动器，并将五个可选平台包固定为与自身完全相同的版本。`amira-win32-x64` 和 `amira-linux-x64` 使用 **baseline** 构建，兼容不支持 AVX2 的较旧 CPU。其他包使用对应的原生目标。启动器透传参数和终端输入输出流，并保留可执行文件的退出状态。

运行 `amira --version` 查看版本、渠道、目标和检测到的安装来源。通过包管理器安装的版本不会自行更新。升级时，执行该命令输出的升级命令（`npm i -g amira`、`pnpm add -g amira` 或 `bun add -g amira`）。检测依据是可执行文件的路径：pnpm 的 store/全局目录和 Bun 的 `.bun/install/global` 目录用于识别对应的包管理器；其他 `node_modules` 安装会显示为 npm。因此，如果非全局 Bun 安装使用了与 npm 兼容的目录结构，也可能被识别为 npm。

候选发布版本使用 `next` dist-tag，例如 `npm i -g amira@next`。Nightly 仅以 GitHub Releases 压缩包的形式提供，不会发布到 npm。

## GitHub Releases 压缩包

从同一个 [GitHub Release](https://github.com/CAMB-dev/Amira/releases) 下载对应平台的压缩包、`SHA256SUMS`、`manifest.json` 和 `manifest.json.sig`。较旧 CPU 优先选择 x64 baseline 压缩包。解压后，将 `amira`（Windows 下为 `amira.exe`）放到 PATH 中的目录。运行解压得到的可执行文件不需要安装 Node.js 或 Bun。

解压前，请对照 `SHA256SUMS` 检查压缩包的 SHA-256。在 Linux 上，如果所有发布压缩包都位于当前目录，可执行：

```sh
sha256sum --check SHA256SUMS
```

如果只下载了一个压缩包，只检查对应的条目。在 macOS 上使用 `shasum -a 256 <archive>`；在 Windows 的 PowerShell 中使用 `Get-FileHash <archive> -Algorithm SHA256`，并将结果与对应条目比较。校验值可以检测文件损坏，但无法防范能够同时替换两个文件的攻击者。

稳定版和候选发布版本还包含使用 Ed25519 签名的 manifest，其中记录版本、渠道、压缩包名称、字节大小和 SHA-256 摘要。请使用通过可信渠道获得的公钥验证签名，再将压缩包的大小和摘要与签名条目比较。不要信任与不可信下载文件一同提供的公钥。签名脚本的命令见下文。公钥尚未嵌入 Amira，这属于后续自行更新功能的批次。现有 nightly 发布包含校验值，但不包含签名 manifest。

## 维护者首次配置

1. 创建 npm 账户，并预留/配置全部六个包：`amira`、`amira-win32-x64`、`amira-linux-x64`、`amira-linux-arm64`、`amira-darwin-x64` 和 `amira-darwin-arm64`。为**每个**包配置可信发布者，关联本仓库的 `release.yml` 工作流。首次发布可能需要使用 npm token，之后才能配置可信发布。
2. 如果无法使用可信发布，将权限范围尽可能小的 npm 发布 token 添加为仓库 Actions secret `NPM_TOKEN`。不要将其存入仓库，也不要传给本地验证命令。发布 job 会请求 OIDC，并使用 npm provenance 来源证明。
3. 使用签名脚本生成 Ed25519 密钥对。将 **PKCS8 PEM** 格式的私钥保存为 Actions secret `AMIRA_RELEASE_ED25519_KEY`，并保留离线备份。命令会输出公钥：请通过可信渠道记录它，用于验证发布。后续自行更新功能的批次会将公钥嵌入 Amira。绝不要提交私钥。
4. 在仓库发布设置中启用**不可变发布**。工作流先将全部资源上传到草稿，再一次性正式发布，绝不修改已发布版本。
5. 发布前，为 **`v*`** 启用仓库标签规则集，排除 `v*-nightly.*`，以便 nightly 保留策略仍能清理其标签。规则集必须禁止更新和删除，且不允许发布操作者绕过。工作流会在创建发布草稿和正式发布前，立即检查远程标签逐层解引用后的提交是否仍与已通过检查的提交一致。必须启用此规则集，防止标签在检查与发布之间被移动。

CI 直接将签名 secret 读入内存，并在内存中推导公钥，绝不将私钥写入磁盘。未配置该 secret 的 dry run 会在内存中生成临时密钥。下面基于文件的命令仅供维护者在本地生成密钥。

在仓库外生成私钥（脚本拒绝覆盖现有文件），并将输出的公钥保存为 `release-public.pem`：

```sh
bun scripts/sign-manifest.ts keygen --key /secure/path/release-private.pem
```

下载发布资源后，使用该可信公钥验证 manifest 签名：

```sh
bun scripts/sign-manifest.ts verify --dist /path/to/downloads --public-key release-public.pem
```

这个验证工具需要在源码仓库的本地副本中使用 Bun；运行 Amira 本身不需要它。

## 发布检查清单

创建标签前，同步 CLI 版本及其在 `bun.lock` 中的 workspace 条目（其他 workspace 的版本保持独立）：

```sh
bun scripts/version-sync.ts bump patch       # Or minor, major, rc
bun scripts/version-sync.ts sync v1.2.3      # Or an explicit v1.2.3-rc.1
bun scripts/version-sync.ts check v1.2.3
```

仅接受 `vX.Y.Z` 和 `vX.Y.Z-rc.N`。标签必须与 `packages/cli/package.json` 一致。稳定版使用渠道 `stable` 和 npm dist-tag `latest`；候选发布版本使用渠道 `next` 和 dist-tag `next`。

发布工作流执行完整检查，交叉编译全部七个目标，并在 Windows、Linux 和 macOS 上对压缩包进行冒烟测试，冒烟 job 不安装 Bun。目前 macOS x64 和 Linux ARM64 没有本机冒烟 runner。随后，工作流签名 manifest、发布 GitHub Release，并**先发布**各平台 npm 包，**最后发布**主包。重新运行时，会跳过 npm 上已存在的版本。

先在发布标签上使用 `workflow_dispatch`，并启用 `dry-run`。它会构建、检查、签名并执行 `npm publish --dry-run`，但不会创建发布版本或发布包。Nightly 不会发布到 npm。本地构建命令见[构建 Amira](building.md)。自行更新和安装脚本不在本批次中实现。
