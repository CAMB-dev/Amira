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

## 单文件安装脚本

从可信的发布版本下载安装脚本，检查内容后再运行。运行 Amira 不需要 Node.js 或 Bun。

macOS / Linux：

```sh
curl -fsSLO https://github.com/CAMB-dev/Amira/releases/latest/download/install.sh
sh install.sh --channel stable
# 固定版本：sh install.sh --version 1.2.3
# 候选发布版：sh install.sh --channel next
```

Windows（PowerShell）：

```powershell
Invoke-WebRequest https://github.com/CAMB-dev/Amira/releases/latest/download/install.ps1 -OutFile install.ps1
./install.ps1 -Channel stable
# 固定版本：./install.ps1 -Version 1.2.3
# 候选发布版：./install.ps1 -Channel next
```

脚本会对照 manifest 校验压缩包的 SHA-256 和大小，在有可信公钥和验证工具时还会验证 Ed25519 签名。未验签时，校验值只能检测损坏，不能证明发布者身份。仓库中的发布公钥默认为空：安装脚本会警告，而 Amira 会停用更新检查，直到维护者在新构建中嵌入公钥。

Windows 将各版本放在 `%LOCALAPPDATA%\Amira\versions\<version>`，将活动版本复制到 `bin\amira.exe`，并把该 `bin` 目录加入用户 PATH。安装后请打开新终端。Unix 将各版本放在 `~/.local/share/amira/versions/<version>`，并用 `~/.local/bin/amira` 符号链接指向活动版本；必要时请将 `~/.local/bin` 加入 PATH。`install.json` 标记用于识别自管安装。配置、凭据和会话数据仍放在 `~/.amira`。

## 更新和回退

只有安装脚本管理的单文件安装会自行更新。手动解压、npm/pnpm/Bun 安装、源码运行、开发构建和 `0.0.0` 版本均不会。包管理器安装执行 `amira update` 时，只显示对应的升级命令。`amira rollback` 不可用，会以错误状态退出；请通过包管理器选择版本。

```sh
amira update --check                # 仅检查，不安装
amira update                       # 安装所选渠道的发布版本
amira update --channel next         # 本次命令选择候选发布版
amira rollback                     # 切换到保留的上一版本
```

后台检查最多每 22 小时一次。补丁更新静默安装，在下次启动时生效；次版本和主版本更新仅显示提示。后台失败不打扰使用。提示显示在 TUI 提示条中，或适合交互的打印模式 stderr 中，不写入机器可读输出。通常保留三个版本供回退，并在启动时清理 Windows 的 `.old.<timestamp>.<pid>` 旧文件。运行中的版本通过会话租约保护，因此会暂时保留超过三个版本，直到这些会话结束。安装脚本也遵守相同的租约。运行中的会话继续使用原来的可执行文件。

在**用户设置**中配置 `updates.auto`、`updates.channel`、`updates.minimumVersion`；项目文件不能修改更新策略。最低版本限制可接受的更新和回退目标，但不会强制后台安装次版本或主版本。回退在更新锁内检查最低版本，不提供绕过参数。详见[设置参考](settings.md)。

环境变量（设为 `1` 启用）：

- `AMIRA_DISABLE_AUTOUPDATE`：关闭后台检查和下载，手动命令仍可使用。
- `AMIRA_DISABLE_UPDATES`：关闭更新检查和安装，包括 `amira update`。
- `AMIRA_OFFLINE`：阻止更新网络请求，包括启动检查。

更新锁用于串行化下载和更新写入。独立的短期保留锁协调租约注册、版本切换和清理，不覆盖网络请求。启动时会对保留锁的短暂竞争进行重试，但不会等待另一个更新进程的下载。租约注册按尽力而为处理：失败不会阻止会话启动；无法建立保护时，该会话跳过后台更新和本地版本清理。如果进程中断后留下锁，请先确认持有该锁的 Amira 进程或安装程序已不再运行，再移除安装目录中的遗留锁。

## GitHub Releases 压缩包

从同一个 [GitHub Release](https://github.com/CAMB-dev/Amira/releases) 下载对应平台的压缩包、`SHA256SUMS`、`manifest.json` 和 `manifest.json.sig`。较旧 CPU 优先选择 x64 baseline 压缩包。解压后，将 `amira`（Windows 下为 `amira.exe`）放到 PATH 中的目录。运行解压得到的可执行文件不需要安装 Node.js 或 Bun。

解压前，请对照 `SHA256SUMS` 检查压缩包的 SHA-256。在 Linux 上，如果所有发布压缩包都位于当前目录，可执行：

```sh
sha256sum --check SHA256SUMS
```

如果只下载了一个压缩包，只检查对应的条目。在 macOS 上使用 `shasum -a 256 <archive>`；在 Windows 的 PowerShell 中使用 `Get-FileHash <archive> -Algorithm SHA256`，并将结果与对应条目比较。校验值可以检测文件损坏，但无法防范能够同时替换两个文件的攻击者。

稳定版和候选发布版本还包含使用 Ed25519 签名的 manifest，其中记录版本、渠道、压缩包名称、字节大小和 SHA-256 摘要。请使用通过可信渠道获得的公钥验证签名，再将压缩包的大小和摘要与签名条目比较。不要信任与不可信下载文件一同提供的公钥。签名脚本的命令见下文。Amira 从 `packages/cli/src/update/public-key.ts` 嵌入可信公钥；公钥为空时禁用自行更新检查。现有 nightly 发布包含校验值，但不包含签名 manifest。

## 维护者首次配置

1. 创建 npm 账户，并预留/配置全部六个包：`amira`、`amira-win32-x64`、`amira-linux-x64`、`amira-linux-arm64`、`amira-darwin-x64` 和 `amira-darwin-arm64`。为**每个**包配置可信发布者，关联本仓库的 `release.yml` 工作流。首次发布可能需要使用 npm token，之后才能配置可信发布。
2. 如果无法使用可信发布，将权限范围尽可能小的 npm 发布 token 添加为仓库 Actions secret `NPM_TOKEN`。不要将其存入仓库，也不要传给本地验证命令。发布 job 会请求 OIDC，并使用 npm provenance 来源证明。
3. 使用签名脚本生成 Ed25519 密钥对。将 **PKCS8 PEM** 格式的私钥保存为 Actions secret `AMIRA_RELEASE_ED25519_KEY`，并保留离线备份。命令会输出公钥：请通过可信渠道记录它，用于验证发布。构建前，运行 `bun scripts/set-release-key.ts /secure/path/release-public.pem` 嵌入**公钥** PEM。该命令验证 Ed25519 公钥，仅修改已提交的公钥源文件；请单独检查并提交公钥变更。绝不要提交私钥。
4. 在仓库发布设置中启用**不可变发布**。工作流先将全部资源上传到草稿，再一次性正式发布，绝不修改已发布版本。
5. 发布前，为 **`v*`** 启用仓库标签规则集，排除 `v*-nightly.*`，以便 nightly 保留策略仍能清理其标签。规则集必须禁止更新和删除，且不允许发布操作者绕过。工作流会在创建发布草稿和正式发布前，立即检查远程标签逐层解引用后的提交是否仍与已通过检查的提交一致。必须启用此规则集，防止标签在检查与发布之间被移动。

首次发布 `next` 之前，请通过具有仓库内容写入权限的 GitHub CLI 身份验证，显式预留元数据分支：

```sh
bun scripts/publish-update-channel.ts bootstrap --repo CAMB-dev/Amira
```

该命令创建仅包含 `.amira-update-channel.json` 所有权标记的 `update-channels` 分支，拒绝接管任何已有分支。如果该名称已被使用，请先单独检查并迁移；发布工作流不会覆盖它。请禁止对该分支强制推送和删除，同时允许元数据 job 追加提交。常规发布要求所有权标记匹配，拒绝意外文件或文件模式，并在比较版本前验证候选和已有 manifest 的签名。缺失、无效或不受信任的元数据会阻止发布，不会被当作更新的版本。

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

先在发布标签上使用 `workflow_dispatch`，并启用 `dry-run`。它会构建、检查、签名并执行 `npm publish --dry-run`，但不会创建发布版本或发布包。Nightly 不会发布到 npm。本地构建命令见[构建 Amira](building.md)。发布资源包含 `install.sh` 和 `install.ps1`，其中使用与二进制相同的可信公钥。`next` 渠道直接从 `https://raw.githubusercontent.com/CAMB-dev/Amira/update-channels/next/manifest.json`（及 `.sig`）获取签名元数据，不调用 GitHub API。串行工作流仅向前更新此专用分支；请允许 Actions token 更新该分支。压缩包始终来自不可变的版本发布。
