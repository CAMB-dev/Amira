# 使用与编写扩展

[English](../extensions.md) · [文档首页](../../README.zh-CN.md)

扩展可以添加工具、命令和界面行为。安装的包可以包含多个扩展、skill 和顶层 CLI 命令。扩展会以你的权限在本机运行代码。

## 查找与管理扩展包

```sh
amira ext search
amira ext search workflow
amira ext list
amira ext help
```

搜索默认使用 [CAMB-dev/amira-extensions](https://github.com/CAMB-dev/amira-extensions) 的官方索引。缓存通常使用一小时，`--refresh` 强制重新获取。`AMIRA_EXTENSIONS_INDEX` 可指向其他索引 URL 或本地索引文件。索引提供包名和来源，搜索不会安装包。官方扩展本身也放在这个仓库中，每个都有 README：workflow 和 swarm（见[子 agent](subagents.md#workflow-与-swarm-扩展)）、lsp 诊断、文件检查点 checkpoints、hooks、todo、notify、share、browser、images 和 mermaid。

安装时可用搜索返回的名称、本地目录、带可选 ref 的 git URL，或 npm 来源：

```sh
amira ext install <name>
amira ext install ./my-extension
amira ext install https://github.com/owner/repo.git#main
amira ext install npm:package-name
amira ext update <name>
amira ext disable <name>
amira ext enable <name>
amira ext remove <name>
```

这些命令支持多个包名或来源。更新时不指定名称，会更新所选范围内的全部包；安装时不指定来源，会按该范围的锁文件恢复缺失的包。禁用会保留包和锁定记录，删除则移除两者。安装、更新和删除支持 `--quiet`（只输出结果）和 `--json`（每行一个结果对象）。

安装本地目录会复制文件，不会建立实时链接。修改源目录后需要重新安装。Git commit 和 npm 版本会明确锁定在 `packages.lock` 中；更新会重新解析来源并写入新的锁定值。

安装、更新、删除、启用或禁用后，重启 Amira，或在空闲时运行 `/reload`。`/help` 会列出已加载扩展注册的命令。

### Git 仓库缓存

Git 扩展包共用 `~/.amira/cache/git` 中的裸仓库（设置 `AMIRA_HOME` 后位于该目录下）。用户锁文件和任何已知项目锁文件引用的缓存都会保留，即使扩展包文件缺失或项目不受信任。已知路径来自会话头和受信任／不受信任项目设置；Amira 也会检查这些路径下的项目锁文件。未被锁文件引用的缓存闲置 30 天后会自动删除。

```sh
amira ext cache list
amira ext cache prune --dry-run
amira ext cache prune
amira ext cache prune --all --dry-run
amira ext cache prune --all
```

`prune` 立即删除未被锁文件引用的仓库，无需等待 30 天；`ext gc` 是它的别名。`--dry-run` 列出将被删除的仓库和中断后遗留的克隆目录，但不实际删除。`--all` 也删除锁文件引用的仓库；`cache clean` 等同于 `cache prune --all`。被其他 Amira 操作锁定的仓库始终保留。删除缓存不会改动已安装的扩展包或锁文件，但恢复缺失的扩展包时可能需要再次联网。

检查缓存不会下载缺失的对象。Git 2.45 及更高版本支持 `GIT_NO_LAZY_FETCH`；旧版本在检查时使用仅对当前命令有效的设置，禁用 origin promisor 并阻止传输，不改动缓存仓库的配置。获取更新和检出扩展包文件仍可下载所需对象。

### 在 Amira 中管理扩展包

`/ext` 无需离开会话就能完成同样的操作。不带参数时，它打开一个列表：先是已安装的包（显示作用域、是否启用、是否受信任，以及索引中是否有新版本），然后是索引中可安装的包。在已安装的包上按 Enter 可以更新、启用或禁用、删除、查看详情；在可安装的包上按 Enter 会询问安装到用户作用域还是项目作用域，然后安装。按 `d` 查看详情。列表中的按键见[快捷键](keybindings.md#对话框)。

```text
/ext
/ext search lsp
/ext install todo
/ext install todo --project
/ext update
/ext disable todo
/ext remove todo --project
```

`install`、`remove`、`disable` 和 `enable` 只接受一个包名；`update` 可以接受任意数量的包名，不带包名时更新该作用域的全部包；`--project` 为 install、update 和 remove 选择项目作用域。规则与 CLI 相同：安装到项目中的包仍需信任该项目才会加载，disable 和 enable 通过用户设置同时作用于两个作用域。安装和更新时会显示进度面板，期间可以继续输入。Esc 或 Ctrl+C 取消正在进行的操作并保留草稿；安装要么完整完成要么不生效，已经完成的更新会保留。

`/ext` 不会自动重新加载。有改动时，它会提示运行 `/reload`，或在当前轮次结束后再运行。`/ext` 操作进行中时 `/reload` 会拒绝执行。安装到未受信任项目的包，要等下次启动时信任该项目，或运行 `amira ext trust` 并重启后才会加载。打印模式和 RPC 模式中可以用带引号的斜杠命令执行这些子命令；列表需要交互界面。

## 用户范围、项目范围与信任

默认安装到 `~/.amira/packages`，锁文件是 `~/.amira/packages.lock`。`AMIRA_HOME` 可以更改用户目录。安装、更新或删除时加 `--project`，则操作当前项目的 `.amira/packages`，锁文件是 `.amira/packages.lock`。

```sh
amira ext install ./my-extension --project
amira ext update --project
amira ext remove <name> --project
amira ext trust
amira ext untrust
```

项目已获得信任时，项目包会替代同名的用户包。未获得信任时，项目包会跳过，用户包仍可加载。首次在有项目包的目录中交互启动，Amira 会询问 **Load them? [y/N]**，并把答案保存到用户设置。Print 和 RPC 模式无法询问，未提前获得信任的项目包会跳过。

同样的信任也决定项目的 `allow` [权限规则](usage.md#权限)是否生效；项目的 `ask` 和 `deny` 规则无论是否信任都会生效。

在项目目录中执行信任或撤销信任命令，然后重启 Amira。信任决定和禁用列表都保存在用户设置中，项目设置不能自行授予信任或重新启用包。按名称禁用会影响两个范围。

`--no-packages` 可在本次运行中跳过全部已安装包；通过 `--extension` 明确指定的文件仍会加载。只安装你愿意在本机运行其代码的包。

## 包清单

包通过 `amira-package.json`，或 `package.json` 内的 `amira` 对象描述其内容。扩展和 skill 路径必须位于包目录内。清单支持以下字段：

| 字段 | 用途 |
| --- | --- |
| `name` | 小写 npm 风格的包名 |
| `version` | Semver 版本，省略时默认 `0.0.0` |
| `engines.amira` | 支持的扩展 API 版本范围 |
| `extensions` | 扩展模块路径 |
| `skills` | Skill 目录路径 |
| `commands` | 顶层 CLI 命令名到模块的映射 |

版本范围针对扩展 API，而不是 CLI 发布版本。[公共 API](../../packages/api/src/index.ts) 导出的 `API_VERSION` 是当前版本。未指定扩展列表时，Amira 依次查找 `index.ts` 和 `src/index.ts`；只提供 CLI 命令的包可以不带扩展入口。

## 一个完整的小扩展

新建名为 `hello-extension` 的目录，放入下面两个文件。它添加用户命令和状态栏计数器，不会发送模型请求。

`amira-package.json`：

```json
{
  "name": "hello-extension",
  "version": "1.0.0",
  "engines": { "amira": "^0.1.7" },
  "extensions": ["index.ts"]
}
```

`index.ts`：

```ts
import { defineExtension } from "@amira/api"

export default defineExtension((api) => {
  const configured = api.settings.extensions?.["hello-extension"]?.message
  const message = typeof configured === "string" ? configured : "Hello from an extension."
  let greetings = 0

  api.registerStatusItem({
    id: "hello-extension.count",
    align: "right",
    text: () => greetings > 0 ? `Hello: ${greetings}` : undefined,
  })

  api.registerCommand({
    name: "hello",
    description: "Print a greeting and update its status counter",
    run(_args, ctx) {
      greetings += 1
      ctx.print(message)
      api.requestRender()
    },
  })
})
```

在需要使用扩展的项目中执行：

```sh
amira ext install ./hello-extension
amira
```

运行 `/hello` 后，每次调用都会在对话记录中输出问候语，并更新状态栏。计数保存在已加载扩展的内存中，重启或重新加载后归零，不会写入会话。

可以通过设置修改问候语：

```json
{
  "extensions": {
    "hello-extension": { "message": "Welcome to this project." }
  }
}
```

修改此设置后重启。开发独立文件时，也可以运行 `amira --extension ./hello-extension/index.ts`，直接加载文件而不安装清单。该选项可重复，相对路径以命令启动目录为准。Amira 在运行时提供 `@amira/api` 导入，独立文件也无需另行安装这个运行时包。

## API 概览

入口默认导出一个函数，通常使用 `defineExtension` 包装。Amira 加载时向它传入 `ExtensionAPI`，函数也可以返回 promise。扩展从 `@amira/api` 导入公共 API，完整类型见 [packages/api/src](../../packages/api/src)。

| API | 用途 |
| --- | --- |
| `registerTool`、`defineTool`、`textResult` | 注册带 JSON schema 和异步执行函数的模型工具，返回文本或图片，也可提供渲染用数据 |
| `registerCommand` | 注册带参数、补全和可选别名的 slash 命令，通过命令上下文输出文字并控制会话 |
| `registerSkill` | 注册通过美元符号前缀调用的 skill |
| `registerInputHandler` | 在普通输入到达模型前，处理符合条件的输入 |
| `registerStatusItem`、`requestRender` | 在状态栏显示当前数据，数据改变后请求重绘 |
| `on`、`intercept` | 订阅有类型的事件，或拦截文档规定的模型、工具和上下文阶段 |
| `complete` | 发起由宿主记账的 side model 调用，不启用工具或托管网页搜索 |
| `session` | 在命令之外访问当前顶层 `SessionControl`；宿主注入前可能为 undefined |
| `ui` | 通过选择、确认、输入、表单和审阅对话框询问用户，命令上下文也提供 UI 请求 |
| `registerPanel` | 在活动行上方渲染实时内容 |
| `registerView` | 注册全屏视图类型，命令在前端支持时通过 `openView` 打开 |
| `registerToolRenderer`、`decorateToolRenderer` | 展示工具调用和结果，或包装已有展示器 |
| `serverToolView` | 将 provider 托管的工具块（如原生网页搜索）转换为与展示器共用的工具调用视图形状 |
| `registerMarkdownRenderer`、`registerImageProvider` | 渲染回复中匹配的代码块、数学公式或独立图片，并提供终端图片数据 |
| `provideService`、`useService` | 共享具名服务；使用时再查找，提供方可能未加载或已卸载 |
| `settings`、`cwd`、`home`、`apiVersion` | 读取合并后的设置、每个顶层键的来源层、工作目录、用户目录和 API 版本 |
| `dataDir` | 必需的只读绝对路径，指向本扩展的持久状态目录，首次访问时创建 |
| `backgroundJobs` | 启动并查看本扩展自己启动的后台任务；内置前端代码使用仅供 host 使用的 `hostBackgroundJobs()` 能力 |
| `runCommand`、`openPipe`、`onExit` | 运行受管理的子进程、启动长期管道进程，或注册短时退出工作 |
| `notify`、`reportError` | 显示提示或报告后台错误 |
| `registerFileRestoration` | 接管回退时的文件恢复（例如 checkpoints 扩展）：选择器显示你提供的选项，core 不再恢复文件；同一时间只能有一个扩展接管，卸载时释放 |

### 扩展状态目录

D111 为 `ExtensionAPI` 增加必需的 `readonly dataDir: string` 属性。`api.dataDir` 是位于 `<api.home>/extension-data/<经过清理的宿主已知身份>` 的绝对路径。目录名由确定性的可读短名称（slug）和原始身份的 SHA-256 哈希组合而成，因此清理后短名称相同的身份仍能区分。宿主传给 `loadFile` 的显式名称（已安装包的名称）决定身份；否则文件加载使用绝对路径（Windows 上统一为小写），而不是文件名或显示标签。直接加载时若没有显式名称，则默认使用来源。同一个已安装包内的所有扩展模块共用此目录，扩展不能自行选择所属身份。

宿主在首次访问 `api.dataDir` 时创建目录；从不访问它的扩展不会创建目录。卸载或重新加载不会清除内容；删除该目录即可重置扩展的存储状态，重新加载后的首次访问会重新创建。请将它用于扩展状态，例如缓存和内部记录，而不是用户文件或项目输出。

只有明确声明 `traits.writesFiles: "paths"`、提供 `getWrittenPaths`，且写入路径报告并集中的每条路径都安全地位于自身 `api.dataDir` 内的扩展工具，才能免除受保护写入审批。注册在内置文件工具名称下的工具，其路径并集还包括参数中指明的路径。报告遵循文件工具的路径语义：相对路径以调用方 agent 的 `cwd` 为基准，而不是 `api.dataDir`。混合目录内外路径的报告不会获得部分豁免，整个调用仍按普通受保护路径规则检查，包括目录外路径。报告缺失、无效，或路径解析未知、不安全时，会请求审批，而不会授予豁免。

包含关系通过原生文件系统对现有路径前缀解析真实路径（realpath）来判断，而不是只比较字符串前缀；新文件可通过已有的父目录进行检查。`extension-data` 命名空间或所属扩展目录被重定向时，即使目标仍在用户目录内，也不能获得豁免；`api.home` 本身是符号链接则允许。符号链接或 junction 导致的目录逃逸，以及有歧义的 Windows 路径形式，都不符合豁免条件。符号链接后跟 `..`，或在处理 `..` 前无法安全解析其父目录时，会请求审批，而不是信任规范化后的路径。

这只免除外层 Amira 用户目录的保护。Git 元数据、`.gitmodules`、配置的 hooks 路径和目录内的 `.amira` 仍需审批。plan 模式仍拒绝写入；shell 权限规则和拦截器的审批请求不变，子 agent 使用相同策略。路径报告是受信任的扩展声明，不是 shell 沙箱、无竞态的授权或独占所有权证明：目录外的硬链接可能指向同一文件。自定义工具必须按文件工具的语义一致地解析报告和实际文件访问。参见[权限](usage.md#权限)。

### Markdown 与数学公式渲染器

`api.registerMarkdownRenderer({ id, match, render })` 接管回复中已完整的节点。代码围栏使用 `match: { codeLang: ["latex", "tex"] }`，独立图片使用 `{ image: true }`，公式使用 `{ math: "inline" | "display" | "both" }`。公式节点为 `{ type: "math", display: boolean, source: string }`，source 不包含定界符。渲染器先按优先级从高到低运行，同优先级按注册顺序运行。返回 undefined、抛出异常或返回无效结果时继续尝试下一个渲染器；无人接管时，原有 Markdown 显示保持不变。

块级公式使用 `$$…$$` 或 `\[…\]`，可以跨行；独占一行的 `$$` 开始一个块。与被接管的代码围栏一样，流式输出期间显示源码，收到结束定界符后才交给渲染器。回复结束时仍未闭合的公式继续显示源码。段落内的行内公式使用 `$…$` 或 `\(…\)`，代码跨度和代码块内不识别公式。起始美元符号后不能紧跟空白，结束美元符号前不能是空白、后不能紧跟数字；`\$` 表示字面美元符号，因此 `$5 and $10` 这样的货币文本不会被识别为公式。

行内公式必须返回 `{ segments: [{ kind: "text", text: "x²" }] }`，这些带样式的文本片段会拼入段落并随段落换行；行内图片和块级 lines 结果会被拒绝。块级公式、代码围栏和独立图片返回 `{ lines: ToolLine[] }` 或 `{ image: ImageInput, alt?: string, fallback?: ToolLine[] }`。alt 描述图片，fallback 提供可读的文本呈现。无法显示图片、复制或打印对话时优先使用 fallback，其次使用 alt；两者都没有时回退为原节点。Core 移除渲染文本中的转义和控制序列，并将块级结果限制为 2000 行。

渲染上下文包含 width、images、maxImageRows 和 `theme: { dark: boolean, foreground?: string, background?: string }`。执行图片工作前请检查 images。纯文本 `amira -p` 将已完整的节点交给同一注册表，设置 `images: false`，无人接管的源码保持原样；此时应返回文本。带 fallback 或 alt 的图片结果会转换成文本。渲染器在 `waitMs` 内没有回应时会被跳过，改为输出源码。`--json` 保留原始事件，不运行渲染器。

TUI 启动时通过终端背景探测选择明暗主题（优先 OSC 11，其次 COLORFGBG，默认深色），整个会话期间保持不变。渲染上下文使用同一选择，单色模式也如此。目前无法确定准确的前景色和背景色，因此省略这两个字段。非交互打印模式默认使用 `{ dark: true }`。渲染缓存的键包含主题。全屏回复在异步结果到达时重绘；内联对话记录等待块级结果的时间由 waitMs 指定（默认 3000 毫秒，最多 15000 毫秒），超时后提交源码。行内公式应同步返回 segments，以便段落进入滚动记录前完成替换。

### 命令回显

命令默认会将输入的 slash 命令行回显到对话记录中。在传给 `api.registerCommand()` 的 `CommandDefinition` 上设置 `echo: false`，即可在内联和全屏 TUI 模式下省略这一行，例如用于 `/btw <question>`。这只隐藏前端的输入回显：命令自身的输出（`ctx.print`、通知和视图）仍照常显示，输入历史（↑）也仍会记录该行。打印模式和 RPC 的行为不变。

### 全屏视图

通过 `api.registerView()` 注册 `ViewDefinition`，命令用 `ctx.openView?.({ kind, data, state })` 打开它，可选的 `state` 为初始 `Partial<UiState>`。视图返回结构化的 `ViewLine` 对象；前端负责终端、换行、滚动、输入提示和确认。`subagent` 类型和 `/agents` 命令由内置 agent 扩展注册。没有加载该扩展时，从对话中的子 agent 块打开视图会提示实时视图不可用。

`title(data, opts)` 返回 `string | ViewLine`，作为第一行。字符串保留默认的 `◆`
标记；语义化的 `ViewLine` 提供完整标题，前端不会自动添加标记。两种形式都会由前端
截断到标题的可用宽度。`titleAside(data)` 在其右端追加一段简短文字，如 `2 of 5`，
这段文字保持完整。

`ViewLine` 支持语义化内容，不使用 ANSI 转义码，样式由前端负责：

- `{ kind: "segments", parts: ViewSegment[] }` 将带样式的文本组合为单行，超出宽度时
  由前端截断，不换行。导出的 `ViewSegment` 类型为
  `{ text: string, kind: "text" | "muted" | "accent" | "success" | "warning" | "error" }`。
- `{ kind: "user-message", text: string, note?: string }` 使用与对话中用户消息相同的显示方式，
  包括换行、背景和间距。只需提供消息文本，不要手动添加 `›` 标记。可选的备注显示在
  消息下方，与消息共用同一背景。

视图按键支持单个可打印字符，以及 `left`、`right`、`tab`、`shift-tab`。标签相同的
按键在底部提示中合并为一项（`←→ switch`）；标签为空的按键（例如另一个按键的别名）
不出现在底部提示中。Esc、q、Ctrl+C 和滚动按键仍由前端处理。按键处理函数通过 `ViewControl` 关闭视图、
请求重绘、调用 `print(text, level?)` 打印快照，或请求输入、确认。打印等级与命令输出
一致：`info`、`warning`、`error`。若要立即返回对话，先关闭视图再打印。

`scrollKey(data)` 返回当前子 agent 或标签页的 id。前端为每个 id 保存滚动位置及
跟随末尾的状态，直到视图关闭。不提供该函数时，视图共用一个滚动状态。
`follow: false` 让每个新 id 从顶部开始显示。

通过 `api.session()` 读取实时快照，通过 `api.on()` 订阅事件；状态变化后调用
`api.requestRender()`。TUI 还会每秒重绘打开的视图，更新耗时。`header` 和 `render`
接收可用宽度、当前时间，以及可选的 `renderTool(toolName, call, detail)` 回调。
该回调使用 host 当前的工具 presenter 和通用渲染器；传入 `ToolCallView`，直接返回
得到的行以保留 host 的显示效果。其他前端可能不提供该回调，因此应提供纯文本行的
回退实现。API 0.1.15 增加了这些视图能力。

D105 增加宿主管理的页面，无需注册另一种视图：调用 `view.pushPage({ title?, state?, data? })` 和 `view.popPage()`。推入页面后，render 和 ui 上下文包含 `page: { depth, data? }`，depth 从 1 开始；根页面不提供 page，回调的第一个参数仍为原视图数据。可选的页面标题替代旧式标题，或在声明式正文上方增加一行标题。每页独立保存选中项、展开项、标签页、输入、焦点和滚动状态，包括旧式 `scrollKey` 位置；弹出页面后恢复上一页。Esc 先取消当前提问，否则弹出页面，在根页面则关闭视图；宿主按键栏在子页面显示 `Esc back`，在根页面显示 `Esc close`。Ctrl+C 始终关闭整个视图，即使正在输入或确认；q 保持原有行为。切换页面会取消尚未回答的提问。

可选的 `onOpen(data, control)` 和 `onClose(data)` 在每次打开和关闭时各调用一次，重绘及页面切换不会触发。初始状态在 onOpen 之前应用，onOpen 可调用 setState 或 close。同类型视图已打开时再次打开，只替换数据，不关闭或重新打开；未提供显式初始状态时保留状态，提供初始状态则从新的根页面开始。替换为其他类型会关闭原视图。

### 子 agent 控制

`SessionControl.messageSubagent(id, text)` 向后代子 agent 发送用户消息：运行中会在下一次模型调用前收到，空闲的持久子 agent 会开始新一轮，排队中的子 agent 仅在获得执行名额后收到。消息以用户身份记录在子 agent 的对话及总线事件中，而不是父模型通知。未知、已结束或正在停止的子 agent 返回 false。`pauseSubagent(id)` 在下一次模型调用前暂停，允许当前模型或工具调用完成，不中止工作或丢失结果；`resumeSubagent(id)` 解除暂停。暂停状态通过 `SubagentInfo.status` 和 `subagent.state` 的 paused 表示。已获准执行的暂停子 agent 仍占用树及组的并发名额，不会为其他子 agent 释放名额；暂停时仍可停止。暂停仅适用于运行中的子 agent，不适用于排队或空闲状态；未知、已结束或已处于目标状态时，暂停及恢复返回 false。此暂停独立于扩展的消息队列（包括 swarm 的暂停），恢复一方不会解除另一方。

RPC 客户端使用 `subagent.message` 携带 `{ sessionId, text }`，使用 `subagent.pause` 和 `subagent.resume` 携带 `{ sessionId }`；响应分别包含布尔值 delivered、paused、resumed。delivered 表示已接受，不保证模型已经看到消息。这些新增能力不改变 `API_VERSION`。

### 声明式视图组件（Experimental，实验功能）

D104 L3 为 `ViewDefinition` 增加实验性的 `ui(data, ctx): UiNode`，不改变 `API_VERSION`。所有类型均从 `@amira/api` 导入，无需依赖 TUI 或 tui-kit。视图提供 `ui` 或原有的 `render`；提供 `ui` 后，它会替代标题、页眉和逐行渲染的屏幕内容，但仍必须提供 `title`，供窗口或错误回退使用。原有纯 `ViewLine` 视图（包括 `/agents` 和任务视图）的行为不变。

```ts
import type { ViewDefinition } from "@amira/api"

const review: ViewDefinition<{ messages: string[] }> = {
  kind: "review",
  title: () => "评审",
  ui: (data) => ({
    type: "column",
    children: [
      { node: { type: "text", id: "log", follow: true,
        lines: data.messages.map((text) => ({ kind: "text", text })) } },
      { size: 3, node: { type: "box", title: "给团队发消息",
        child: { type: "input", id: "message", placeholder: "请检查键盘操作…" } } },
    ],
  }),
  onEvent(event, data, view) {
    if (event.type === "submit") {
      data.messages.push(event.value)
      view.setState({ inputValues: { message: "" } })
    }
  },
}
api.registerView(review)
```

`UiNode` 使用 `type` 区分组件：`column` 和 `row` 接收 `children: { node, size?, min? }[]`、`gap?` 和 `divider?`；`box` 接收 `child`、`title?: ViewLine | string`、`aside?`、`border?: "round" | "none"` 和 `tone?: "normal" | "accent" | "focus"`；`text` 接收 `lines: ViewLine[]`、可选 `id` 和默认关闭的 `follow`；`tree` 接收 `id` 和 `items: UiTreeItem[]`；`tabs` 接收 `id`、`tabs: { key, label, body }[]` 和 `style?: "brackets" | "divided"`（默认 `"brackets"`），只布局当前标签页。

`table` 接收可选 `id`、`columns: { key, label, size?, align?: "left" | "right" }[]` 和 `rows: { key, cells: Record<string, string | ViewSegment[]> }[]`；`bar` 接收语义片段数组 `left` 和可选的 `right`；`progress` 接收范围为 0 到 1 的 `value`（超出时截取到边界），以及可选的进度条最大 `width` 和 `label`；`rule` 接收可选 `label`；`input` 接收 `id`、`placeholder?`、`hint?` 和 `activate?: string`（例如 `"i"` 或 `"/"`），应配合可见标签（例如框标题）使用；`spacer` 的可选 `size` 指定主轴默认空白格数。

内容只描述文本和 `ViewSegment` 的语义，不使用颜色值或原始转义序列。所有显示字符串（包括标题、标签、表格单元格、提示和输入值）都使用与原有视图行相同的清理规则。超长单行以省略号截断，普通文本行保留原有换行行为；主题、裁剪、输入和终端均由宿主管理。

`Size` 为 `number | \`${number}%\` | "fill"`：分别表示固定终端格数、扣除间距及分隔线后主轴空间的百分比，以及均分剩余空间。省略尺寸时使用 fill，但 spacer 显式提供的 size 会成为默认值。每条分隔线在 `gap` 之外另占一格。先保留可满足的 `min`，再按比例缩小超出部分；只有最小尺寸之和也无法容纳时才缩小最小尺寸，并按声明顺序分配取整余量。矩形尺寸不会变成负数；不足八列或三行时隐藏框边。表头和单元格共用列宽分配，列间隔为一格。可根据 `ctx.width` 为窄终端选择不同的组合。

`UiTreeItem` 包含稳定的 `key`、语义片段 `row`，以及可选的 `aside`、`detail: ViewLine[] | UiNode`、`children`、`rail` 和 `expandable`。详情仅在展开时显示，位于该行下方、子项之前。组件详情位于树的连接线和缩进内，宽度为缩进后的剩余空间，高度由内容决定：文本换行，表格包含表头和所有行，box 加上边框，row 取最高子项，column 累加子项高度、间距和分隔线。column 子项的数值尺寸和最小高度仍生效；由于没有固定的垂直空间预算，省略尺寸、fill 和百分比高度均使用内容高度；row 的宽度仍按普通 Size 规则分配。详情支持 box（含 title、aside、border、tone）、row、column、text、progress、bar、rule、table 及空白 spacer，均为只读展示：忽略 ID 和 follow，不接管焦点或滚轮，也不渲染嵌套的 tree、tabs、input。焦点仍在树上，select/activate 事件仍携带树项键；可用工作者树项的 detail 显示卡片。`expandable: true` 可在子项尚未加载时显示展开标记，扩展通过 toggle 事件加载数据；树默认折叠；在树节点上设置 `expanded: "all"` 可默认展开，包括后来新增的行，但显式初始状态、setState 和用户切换优先，因此用户折叠的行在重绘及页面恢复后仍保持折叠。

时间线行可增加 `lead?: ViewSegment[]`、`gap?: number`、`node?: ViewSegment[]` 和 `underline?: boolean`。gap 指定 lead 后的间距格数，默认为 1。lead 位于焦点标记之后、连接线之前，形成所有可见树项共用的固定宽度列：按当前未被折叠隐藏的项及其间距确定宽度，并限制上限以保留正文空间；没有 lead 的行及详情、下划线也保留该列。它适合显示时间和状态标记。node 替代该行两格宽的展开标记或连接线位置（例如 ○、◉），按两格裁剪或补齐；左右键仍可折叠和展开。`rail: true` 在详情和下划线旁延续 │，并用 ├─、└─ 连接子项；lead 和 node 本身不会启用连接线。underline 在展开详情之后（折叠时紧接该行）、子项之前增加细横线，连接线穿过缩进区域。

任何接受 ViewSegment 的位置均可用 `{ kind: "chip", text: "TypeScript", tone: "info" }` 显示小标签。tone 可省略，默认为 neutral，也可为 info、success、warning、danger 或 accent。颜色由宿主决定，显示为 ▐text▌，两端半方块使用标签背景色；无颜色、纯文本输出或主题没有 chip 令牌时使用 ▏text▕。标签与其他片段一样经过清理和裁剪。原有纯文本及 print 路径仍受支持；print 模式不打开交互式视图。

标签栏默认使用 `style: "brackets"`。设置 `style: "divided"` 后，标签之间显示分隔线；彩色模式下，选中标签加粗并使用强调色背景，单色模式下则用方括号标记。

`ViewDefinition.hostKeys?: "full" | "minimal" | "none"` 控制宿主按键栏。默认 `"full"` 显示完整按键栏；`"minimal"` 仅显示 `Esc back` 或 `Esc close`；`"none"` 移除页脚行，但 Esc 仍然有效。所有模式下，输入提问和确认提示仍然可见。

设置 `activate` 的输入框不会自动接管键盘输入：按激活键后才进入输入框。占位文本包含激活提示；也可通过显式 `view.focus(id)` 或 Tab 切换进入。Esc 先退出已激活的输入框，再弹出页面或关闭视图。省略 `activate` 时保留自动聚焦输入框的行为。

`UiContext` 在 `ViewRenderOptions` 基础上增加宿主持有的 `state: UiState` 和 height；height 为扣除等待提示、宿主按键栏及子页面标题后正文可用的行数，不会为负，并随终端尺寸变化更新。所有映射以稳定、整个视图内唯一的组件 ID 为键：`selected` 保存树或表格的选中项键，`expanded` 保存树中展开项的键数组，`activeTabs` 保存标签页键，`scroll` 保存 `{ top, following }`，`inputValues` 保存输入字符串；可选的 `focused` 保存焦点组件 ID。重绘、同类型视图的数据替换和非活动标签页均保留状态，直到视图关闭。选中项或标签页消失时选择第一个可见项或标签页；焦点无效时选择第一个无需输入激活的可见组件。请将上下文状态视为只读，并保持 `ui` 无副作用：宿主修复选中项、标签页或焦点后可能在同一帧重建内容，确保详情与控件一致；八次尝试后仍不稳定时安全地显示错误。没有 ID 的文本和表格可用滚轮滚动，但键盘焦点和显式状态管理需要稳定的 ID。

`onEvent(event, data, view)` 接收以 `type` 区分的事件：带 `{ id, key }` 的 select/activate、带 `{ id, key, expanded }` 的 toggle、带 `{ id, key }` 的 tab、带 `{ id, value }` 的 submit，以及已声明按键的 `{ key, focused? }`。在 `keys` 中声明快捷键（例如 `keys: [{ key: "x", label: "停止" }]`）；声明式视图通过 `onEvent` 接收它们，不调用旧的 `run` 回调。未声明的按键不产生事件。宿主先更新状态，再调用处理函数，因此 `view.setState(patch)` 可以覆盖默认结果。补丁为浅层替换：提供的顶层映射会替换整个映射，而不是合并其中条目；需要保留其他条目时使用 `{ ...ctx.state.selected, [id]: key }`。`view.focus(id)` 聚焦可见组件。原有 close、requestRender、print、prompt 和 confirm 方法仍可使用。提交输入不会自动清空内容。

Tab/Shift+Tab 在可见的树、带 ID 的表格及文本、标签栏和输入框之间移动焦点。没有可聚焦组件时，它们会通过 onEvent 交给已声明的 tab/shift-tab 快捷键；未声明的键不产生事件。树用上下键选择，右键展开，左键折叠或选择父项，Enter 激活；表格用上下键选择，Enter 激活；标签栏用左右键切换；输入框用 Enter 提交。翻页键及 Home/End 滚动当前可滚动组件，滚轮作用于指针下的组件，不改变焦点或选中项。文本仅在 `follow: true` 或滚到末尾后跟随增长，向上滚动会停止跟随。组件按键优先于声明的快捷键，其余已声明按键交给 onEvent。Esc 先取消当前输入或确认提问，其次退出设置了 `activate` 的输入框，否则弹出页面或关闭根视图；Ctrl+C 始终关闭整个视图。q 关闭视图，但获得焦点的声明式输入框或 prompt 覆盖层会把它当作输入。prompt/confirm 覆盖层暂停组件输入，并独占光标。

输入、数据更新和 requestRender 会触发重绘，不增加组件动画计时器。树在每次准备布局时仅索引展开的行，只绘制视口内的行。纯语义组件仪表盘测试、180×52 和 80×24 快照位于 `packages/tui/test/ui-runtime`；运行 `bun packages/tui/test/ui-runtime/benchmark.ts` 可复现 180×50 下的 500 项嵌套树基准测试，覆盖 80 个组件卡片详情、时间线样式、展开及折叠状态，以及完整的 ExtensionViewer 路径。组件详情仅在所属项展开时测量，只绘制与视口相交的部分。

### 工具能力

请在 `traits` 中声明工具对 host 可见的能力，不要依赖工具名称；`readOnly: true` 允许工具在 plan 模式运行，`writesFiles: true` 表示工具会写文件，`writesFiles: "paths"` 还要求 `getWrittenPaths(params, { cwd })` 返回本次调用可能写入的全部路径，路径可以相对于 `cwd` 或使用绝对路径。
带有有效路径报告的写文件工具会参与和内置文件工具相同的受保护路径检查，但有一项有限的[扩展状态目录](#扩展状态目录)豁免；host 也会捕获写入前后的文件内容用于回退；报告缺失或无效时会采取保守策略并请求确认。
如果工具已经自行使用 `ctx.mutateFiles`，请设置 `usesMutationHook: true`，这样 host 不会再添加第二个回退边界。
运行命令的工具应设置 `shell: "bash"` 或 `shell: "powershell"`；如果实际 shell 在运行时才确定，也应保留 `shellKind()`。
编辑工具替代品应设置 `editor: "edit"` 或 `editor: "apply_patch"`，读取已保存输出的工具设置 `artifactReader: true`，延迟工具加载器设置 `toolSearch: true`，需要界面的工具设置 `interactive: true`。
`readKey(params, { cwd })` 可以为可重复的直接文件读取提供上下文去重标识。
未声明的能力仍视为未知：权限检查、回退和工作区刷新会继续采取保守行为；MCP 工具目前没有已知能力声明。

能力声明是受信任的：扩展以你自己的代码运行，因此对于工具自己的名字，声明 `readOnly` 或报告的路径少于实际写入的路径，都会被采信。但声明不能削弱内置名字的保护。注册在 `write`、`edit`、`apply_patch`、`bash`、`powershell` 或 `ask_user` 名下的工具（例如 `override`）无论声明什么，都保留该名字隐含的能力：`write`、`edit` 和 `apply_patch` 始终是写文件工具，除了它报告的路径，还会按参数中指明的路径做受保护路径检查；`bash` 和 `powershell` 始终是 shell 工具，受你的命令规则约束（除非 `shellKind()` 给出答案，bash 会按两种 shell 读法都检查）；它们在 plan 模式下都不算只读。既写文件又运行 shell 的工具会同时按两者检查。回退只捕获声明的写文件工具所报告的路径；`usesMutationHook: true` 告诉 host 该工具会通过 `ctx.mutateFiles` 自行捕获写入，声明了却没有这样做的工具不会被捕获。host 捕获声明的写文件工具时，整个调用期间都占用会话的文件捕获队列：其他文件写入（包括同一目录中的子 agent）都要等待它完成，因此这类工具应尽快结束，且不要等待其他 agent 的文件写入。

`serverToolView(block)` 返回 provider 工具的名称、参数、结果文本和原生搜索详情（包括来源）；未完成的工具块还会带上 `rejected: "aborted"`。可以把其中的 `ToolCallView` 字段交给已有的工具展示器或其他前端使用；它只用于渲染，不能作为本地工具结果发回 provider。

命令可以调用 `ctx.openRewind()` 打开与连按两次 Esc 相同的回退选择器；只有具备该选择器的前端（终端 UI）才提供这个方法，选择器暂时无法打开时（例如轮次进行中）返回 false。

扩展设置放在 `extensions` 中，以扩展名为键。设置快照被冻结，扩展应自行校验自己的字段；`api.settings.layers(key)` 按优先级顺序返回顶层键的显式值，每项带有 `scope`（`user`、`project`、`project-local` 或 `flags`）、`file` 和 `value`，没有该键时返回空数组。宿主重新加载设置时（包括 `/reload`）会提供新的快照和来源层，扩展可以据此协调长期资源，而无需自行读取设置文件。Print 模式会取消 UI 对话框，RPC 客户端通过协议回答。Panel、视图、工具展示器、Markdown 渲染器、图片 provider 和服务 API 目前属于实验功能。

`runCommand` 在命令退出后才返回。想边运行边拿到输出（比如显示一条耗时的 `git` 命令的进度），就传入 `onChunk`。通过 `signal` 中止（或等 `timeoutMs` 到期）会杀掉整个进程树，结果里的 `aborted` 或 `timedOut` 会说明原因。默认情况下，`output` 只保留最后 1,000,000 个字符；可以用正整数 `maxOutputChars` 覆盖该限制（无效值会导致调用被拒绝）。`onChunk` 仍会收到全部输出，`truncated` 会说明 `output` 是否被截断。截断不会拆开 UTF-16 代理对。

`complete({ messages, system?, model?, maxTokens?, signal?, label? })` 在对话之外发起一次模型请求，不带工具，关闭托管网页搜索，返回回复的文本、消息和用量。默认使用会话当前的模型（`model` 接受 `provider/model` 引用）。每次请求都会消耗你的 token：用量保存在会话中，在 `/cost` 里以 `label`（未设置时为扩展来源）列出，并计入 agent 树的 `budget`；预算用完后调用直接被拒绝，不会发出请求。推理模型至少获得 2,048 个输出 token（不超过其上限），以便思考后仍能作答。provider 错误会让 promise 被拒绝；`signal` 中止或扩展被卸载时，以 `AbortError` 拒绝。`session()` 在宿主建好会话控制后返回顶层会话的 `SessionControl`；`rename(title, { source: "auto", sessionId })` 不会覆盖 `/rename` 设置的名称，`sessionId` 已不是当前会话时什么也不做。

### 会话思考强度

API 0.1.20 新增 `SessionControl.setThinking(level: ReasoningEffort | undefined): void`。通过命令上下文或 `api.session()` 获取控制对象；宿主注入之前，后者可能返回 `undefined`。可选档位为 `low`、`medium`、`high`、`xhigh` 和 `max`。覆盖值只对当前会话生效，不写入设置文件，优先级高于 `--thinking`、模型级设置和顶层设置，后三者的优先级依次降低。传入 `undefined` 会明确屏蔽这些来源，不发送推理强度参数，沿用服务端默认值；它并不是移除运行时覆盖值。

轮次、压缩或重新加载进行中时，`setThinking` 会抛出错误。选择会保留给之后切换到的思考模型，变更后启动的子 agent 也会继承它。与当前模型一样，`/clear`、`/resume`、回退或分支切换到的对话会沿用该选择；它只保存在内存中，新启动的 Amira 进程会重新按标志和设置确定强度。

`ui.select(title, options, { initial, signal })` 接受可选的 `initial` 选项标签，用于指定选择器打开时高亮的选项；没有匹配标签时高亮第一项。取消选择器会返回 `undefined`；内置强度选择器会保留当前选择。

`SessionControl.info()` 返回的 `SessionInfo` 包含以下字段：

| 字段 | 含义 |
| --- | --- |
| `thinking?: ReasoningEffort` | 发送给当前模型的强度；未设置或模型不支持思考时为空 |
| `thinkingLevel?: ReasoningEffort` | 不受当前模型能力限制的有效选择；切换到不支持思考的模型时仍保留 |
| `supportsThinking?: boolean` | 当前模型是否支持思考；Amira 宿主会提供布尔值 |

运行时强度变化会触发有类型的 `thinking.changed` 事件，数据载荷为 `{ thinking?: ReasoningEffort }`。其中 `thinking` 与 `info().thinking` 一样受模型能力限制，不等同于 `thinkingLevel`。实时显示应读取 `api.session()?.info()`，在 `thinking.changed`、模型变更和会话变更时重绘。只显示顶层会话时，应忽略带有 `parentSessionId` 的事件。内置状态栏仅在 `info().thinking` 有值时，在模型名旁显示强度。

### 会话追踪

宿主负责记录每个会话的可观测性追踪（D103）；查看器位于独立仓库。这不是需要加载的扩展，不改变 agent 循环或 `API_VERSION`。持久化会话文件 `<session file>` 旁会有 `<session file>.trace.jsonl`；每个已持久化的子 agent 在 `subagents/` 下的会话文件旁有自己的追踪文件，嵌套后代也一样。临时会话，以及尚未创建对话文件的会话，不产生追踪文件。

`SessionControl.trace(sessionId?: string): Promise<TraceRecord[]>` 默认读取当前会话，也可以读取 `subagents()` 列出的后代。通过 `api.session()` 或命令的 `ctx.session` 获取控制对象。无关的 ID、没有追踪的会话或缺失的文件返回 `[]`；这不是任意文件读取 API。返回的是已完成记录的快照，包括为本次读取刷新的已完成记录缓冲，不会为仍在运行的工作合成区间。它不排空事件总线，因此尚未送达记录器的事件可能缺失；从事件监听器调用不会等待该监听器本身。读取器跳过格式错误或不完整的行，以及版本不受支持的记录段。

```ts
import { summarizeTrace } from "@amira/api"

const session = api.session()
if (session) {
  const records = await session.trace()
  const summary = summarizeTrace(records)
  const child = session.subagents()[0]
  const childRecords = child ? await session.trace(child.id) : []
}
```

写入采用异步批处理，至少每秒安排一次，并在会话结束和进程退出时刷新；不会让轮次等待磁盘 I/O。记录失败每个会话只报告一次，不会使 agent 失败。追踪采用尽力持久化：突然终止或订阅者队列过载可能丢失事件。恢复会话时向已有追踪追加新头记录，不截断旧内容。分支只复制对话，不复制追踪；分支在开始记录时创建自己的追踪。删除会话时删除它及其独占后代的追踪，仍被其他会话共享的后代则保留。

#### 记录格式与隐私

`@amira/api` 导出 `TRACE_VERSION = 1`、`TraceRecord`、`ToolOutcome`、`TraceSummary` 和 `summarizeTrace`。JSONL 每行是一条记录，每段记录以 `trace` 头记录开头。下表列出 `type` 判别字段以外的全部字段；可选列中的字段可以省略。`Usage` 是公开的 token、搜索次数及美元费用用量类型；模型字符串使用 `provider/model` 格式。

| `type` | 必需字段 | 可选字段 |
| --- | --- | --- |
| `trace` | `v: 1`、`sessionId: string`、`startedAt: number` | `parentSessionId: string`、`role: string`、`title: string` |
| `turn` | `turnId: string`、`start: number`、`end: number`、`reason: "done" \| "error" \| "aborted"`、`steps: number` | `failure: { kind: string; message: string }` |
| `model` | `model: string`、`start: number`、`end: number` | `turnId: string`、`firstToken: number`、`usage: Usage`、`stopReason: string`、`retries: { at: number; delayMs: number; kind: string }[]` |
| `tool` | `toolCallId: string`、`name: string`、`start: number`、`end: number`、`durationMs: number`、`outcome: ToolOutcome`、`argsChars: number`、`resultChars: number`、`argsPreview: string`、`resultPreview: string` | `turnId: string`、`approvalWaitMs: number`、`approval: "user" \| "rule"`、`artifact: string`、`writtenPaths: string[]` |
| `status` | `at: number`、`status: "idle" \| "working" \| "blocked" \| "error"` | `reason: string` |
| `subagent` | `childSessionId: string`、`start: number`、`end: number`、`status: string`、`durationMs: number` | `toolCallId: string`、`role: string`、`title: string`、`groupId: string`、`queuedAt: number`、`error: string`、`usage: Usage` |
| `compact` | `start: number`、`end: number`、`reason: string` | `tokensBefore: number`、`tokensAfter: number`、`usage: Usage`、`native: boolean`、`fallback: boolean` |
| `side` | `at: number`、`model: string` | `label: string`、`usage: Usage` |

全部时间戳（`startedAt`、`start`、`end`、`at`、`firstToken`、`queuedAt`）均来自事件信封的 `ts`，单位为 Unix 纪元毫秒，不是追加文件的时间。持续时长和重试延迟也使用毫秒。区间记录在结束时追加，因此文件顺序不等于开始时间顺序。轮次对应 `turn.start/end`；模型记录对应 `message.start/end`，保留该请求内的重试。`firstToken` 是首次可靠观测到的消息增量时间，可以是文本、思考或工具调用；增量缺失或被丢弃时可能没有此字段。失败轮次使用结构化失败的分类和摘要；未分类错误使用 `"other"` 分类。

工具参数预览是紧凑 JSON；结果预览仅包含文本块。每个预览最多 300 个 Unicode 码点，不拆开代理对。`argsChars` 统计紧凑 JSON 的码点数，`resultChars` 统计事件结果文本的码点数；后者可能已经是 artifact 预览，而非原始输出。`artifact` 是已保存输出的 ID，不是路径。追踪不复制图片、结果详情或完整参数／结果；完整内容仍保存在会话／artifact 存储中。预览和路径仍可能包含敏感文本，应把追踪视为私密会话数据。

`ToolOutcome` 为 `"ok" | "error" | "denied" | "aborted" | "invalid" | "unknown-tool"`。拒绝原因优先：`tool.execute.end.rejected` 的 `blocked`、`aborted`、`invalidArgs`、`unknownTool` 分别映射为 `denied`、`aborted`、`invalid`、`unknown-tool`。否则根据 `result.isError` 选择 `error` 或 `ok`，不会根据结果文本猜测是否中止。开始和结束按会话、轮次、调用 ID 和工具名配对；重复键使用先进先出。若同一并行批次中的调用具有相同 ID 和工具名，且乱序结束，现有事件无法区分它们，对应的开始时间／预览可能有歧义。

`tool.execute.end.waitedMs?: number` 只测量实际等待审批的时间，在追踪中成为 `approvalWaitMs`。真实等待即使耗时为零也保留 `0`。未等待、策略直接拒绝、没有审批处理器，以及工具提问等待，都没有该字段。`durationMs` 只测量执行时间，不包括审批、执行前检查和调用前后拦截器；执行前被拒绝的调用报告零。工具开始／结束事件区间还可能包含调度和后处理，因此不一定等于 `durationMs`。并发审批等待可以重叠，不是额外的墙钟时间。

父会话的 `subagent` 记录描述已结束的直接子 agent 及其自身用量，不递归包含后代。只有 `subagent.start` 宣告子 agent 进入队列时才有 `queuedAt`；执行 `start` 来自子 agent 实际的 `session.start`。在该宣告前取消的子 agent 使用 `start === end`，表示没有执行区间。报告的子 agent `durationMs` 是获准运行后的存续时长，持久子 agent 的空闲期也可能计入。每个子 agent 自己的追踪包含其轮次、模型和工具详情。

压缩记录不包含摘要文本。成功记录包含触发原因及可选的 token／用量；`native` 和 `fallback` 是布尔值，不是原始模型引用或回退说明。失败尝试使用 `reason: "failure:blocked"`、`"failure:empty"` 或 `"failure:error"`；没有先前开始事件时使用 `start === end`。格式保留了 `side` 变体，但宿主目前没有旁路请求用量事件，因此不写入 `side` 记录。不会轮询或转换已存储的 `side_usage` 条目及预算更新来生成追踪；已存储的旁路请求用量请通过 `sideRequests()` 读取。

#### 追踪汇总

`summarizeTrace(records: TraceRecord[]): TraceSummary` 是不修改输入的纯函数。传入一个会话的追踪，可以包含恢复会话的多个头记录；不要拼接父子会话追踪，因为父会话的子 agent 记录已经报告了子 agent 用量。各时间指标可以重叠，不能相加来还原墙钟时间。

| 汇总字段 | 统计方式 |
| --- | --- |
| `start?`、`end?`、`wallTimeMs` | 记录所表示事件的最早和最晚时间，包括排队／重试时间；墙钟时间是两者之差，不是数组首尾记录之差。包括恢复会话前的停机时间。空输入没有时间边界，时长为零。 |
| `modelTimeMs` | 模型请求区间之和，包括重试延迟。 |
| `modelWaitMs`、`modelStreamMs`、`modelUnknownMs` | 存在 `firstToken` 时，分别累加开始到首个 token、首个 token 到结束的时间；否则整个区间归入未分类的 `modelUnknownMs`。 |
| `toolTimeMs` | 工具开始／结束区间的并集；并行重叠部分只计算一次。 |
| `toolDurationMs`、`approvalWaitMs` | 分别累加报告的工具时长和真实审批等待；同时发生的等待可以重叠。 |
| `idleMs` | 每个头记录划分的运行段内，轮次区间之间的间隔；不包括恢复前的停机时间，也不包括首轮之前或末轮之后的时间。 |
| `usage`、`subagentUsage`、`totalUsage` | 自身模型／压缩／旁路请求用量、直接子 agent 自身用量，以及两者之和。保留推理 token；任何计入的用量费用未知时，总费用为空，未定价搜索仍保持未定价状态。 |
| `tools[name]` | 基于报告的 `durationMs` 计算 `count`、`totalMs`、`avgMs`、`maxMs`；`outcomes` 包含全部六种结果的计数，包括零值。 |
| `failures` | 所有非 OK 工具，以及失败／中止轮次，按完成时间 `at` 排序，包含来源标识、结果／原因，以及可用的有界工具预览或轮次失败摘要。 |
| `retries` | 已记录的模型重试条目数。 |
| `subagents` | 已结束的直接子 agent，包含 ID、可选角色／标题、开始／结束时间、报告的存续时长、状态、可选用量和已知美元费用 `cost`。 |

用量总计只涵盖已报告的用量，不保证覆盖全部计费工作。尤其是没有事件的旁路请求、没有模型事件的父模型咨询，以及未报告的失败请求用量，无法从追踪还原。需要子 agent 的详细时间或后代信息时，请单独读取它的追踪。

### 工作区 provider

API 0.1.16 新增 `api.registerWorkspaceProvider(provider)`。每个宿主只允许一个 provider；
重复注册会抛出错误并指出当前注册者。返回的函数用于注销，卸载、加载失败和重新加载也会自动注销。

```ts
import type { WorkspaceProvider } from "@amira/api"

const provider: WorkspaceProvider = {
  async probe(cwd, signal, kind = "full") {
    // Honor signal; use api.runCommand for processes. A dirty probe may reuse metadata.
    return { cwd }
  },
  // Optional: a cheap metadata fingerprint, with no process spawn.
  stamp(cwd) { return undefined },
}
api.registerWorkspaceProvider(provider)
```

`WorkspaceFacts` 是 `workspace.changed` 的数据载荷，包含 `cwd` 以及可选的 `repoRoot`、
`branch`、`head`、`isWorktree`、`dirty`。返回的 `cwd` 必须与请求完全相同，否则宿主会拒绝结果。
无法获得信息时返回 `undefined`。provider 不发送事件，也不提供 `sessionId`、`seq`、`ts`；
这些字段由宿主设置，结果绑定到当前顶层会话。切换会话、结束会话或注销 provider 时，宿主会取消
未完成的探测；即使 provider 忽略取消信号，迟到的结果也会被丢弃。

宿主在启动后等待 500 毫秒再探测，合并重叠的请求，只在信息变化时发送事件。每轮结束后，若 stamp
改变则完整探测；若 stamp 未改变，但运行过可能写文件的工具，或距上次检查已过 60 秒，则请求 dirty
探测。只有明确声明 `writesFiles: false` 的工具可以跳过写入提示；未知工具和子代理工具仍按可能写入
处理。未提供 stamp 时，每轮结束都会完整探测。stamp 也应反映仓库的出现或消失。provider 可以用完整
结果回答 dirty 请求。

内置 agent 扩展提供 Git 探测。使用 `--no-builtins` 且没有替代 provider 时，不会产生工作区事件或分支
标签；`/status` 最多等待两秒，然后显示 Git 信息未知。重新加载时会重放当前会话最后的工作区事件。
`@amira/core` 中已弃用的导出仍可使用：`gitInfo` 依旧是独立的一次性 Git 探测，不需要 provider；
`trackWorkspace` 会（重新）启动其总线上的宿主跟踪器，在该总线注册 provider 之前不会发送任何事件。

### 后台任务

`ExtensionAPI.backgroundJobs` 是扩展级视图：它只能启动任务，并列出、读取、等待、停止和订阅本扩展自己启动的任务；它不能配置 host 注册表、停止全部任务、关闭会话或在根会话之间转移任务。`/jobs` 命令和 TUI 面板等内置前端代码使用仅供 host 使用的 `hostBackgroundJobs()` 能力，因此仍能看到工具启动的会话任务；工具执行器应使用会话级的 `ctx.backgroundJobs`，因为这个公共边界会携带任务所有权和可见性。

启动任务时提供 `command`、`argv`、`cwd`、`env` 和 `shell`。会话 host 会自动记录子 agent 的所有者；主会话可以看到自己的任务和所有子 agent 的任务，子 agent 只能看到自己的任务。`list`、`get`、`running`、`output`、`tail` 和 `stop` 都会执行可见性检查，不可访问的任务会按不存在处理。

`readNew` 为每个 reader 名称维护独立游标，因此多个 reader 可以分别增量读取同一份输出。`waitFor` 可以等待正则表达式匹配、进程退出、超时或 abort signal。`subscribe` 只会报告本扩展任务的启动、状态、输出和结束变化；先用带宽限期的 `stop`，需要强制停止时再用 `0` 调用一次。

host 注册表向内置 host 代码提供 `maxRunning`、`configure`、`stopAll` 和 `isLimitError` 来处理限制。子 agent 的会话任务会在 `subagent.end` 事件交付后自动停止。顶层会话任务会跨越 `/clear`、`/resume` 和 `/fork` 继续运行：替换后的根会话可以列出、读取和停止它们，任务结束通知也会交付给新会话。直接通过 `ExtensionAPI.backgroundJobs` 启动的任务不会归属于调用会话，而会在启动它的扩展卸载（其 `subscribe` 监听也一并移除）或 Amira 退出时停止。卸载扩展（包括 `/reload`）不会停止会话中工具启动的任务。扩展应使用这个收窄后的 API，不要访问 `@amira/proc` 的全局注册表。

注册方法返回移除函数，host 会跟踪注册。卸载时自动移除；加载失败则回滚已注册内容。命令、工具、skill、状态项或 panel 重名时，有意替换需要 `override: true`，具体冲突规则以对应类型为准，避免意外替换其他扩展的内容。

事件包括 `session.start`（携带可选的初始 `title`）、`workspace.changed`、`tool.execute.start` 和 `tool.execute.end`（两者都带有工具的 `traits`，写文件工具还带有它报告的 `writtenPaths`）。监听器收到的事件封装包含数据和会话 ID，维护会话状态时应按会话筛选。重新加载后，新注册的监听器会收到当前会话、工作区、预算事件以及最新的 `ui.focus` 和 `ui.waiting` 状态。等待状态以 visibility 变化重放，不会再次宣布问题打开。自行创建的原生资源仍需自行清理。

`api.terminal` 是稳定的结构化能力，提供 `setTitle(title: string)`、`setProgress(state: "none" | "indeterminate" | "paused")` 和 `bell()`，不暴露原始写入或转义序列。在 print 和 RPC 前端，这些方法不执行任何操作。TUI 清理标题中的控制字符，将其限制为 128 个终端单元格，在帧写入之外的微任务边界合并输出，遵守 `tui.title`、`tui.progress` 和 `tui.bell` 设置，检测进度支持，并在退出时恢复终端。

内置 `@amira/ext-terminal-status` 负责标题组合、工作与等待进度以及响铃策略；`--no-builtins` 会禁用它。问题（包括本地 rewind 对话框）、表单及覆盖视图变化后，TUI 发出 `ui.waiting`：`{ pending: number, hidden: boolean, change: "opened" | "resolved" | "visibility" }`。`hidden` 表示覆盖视图挡住了待回答的问题。隐藏问题打开时只响铃一次，可见性变化不再响铃。焦点通过 `ui.focus` 传递；完成回合或打开可见问题时，窗口失焦则响铃，焦点未知则在回合持续 15 秒后响铃。中断的回合不响铃。

修改入口文件后可用 `/reload`。入口导入的其他模块仍有缓存，因此修改辅助模块后需要重启 Amira。渲染回调应保持轻量，改变可见状态后调用 `requestRender`。

相关文档：[快速开始](getting-started.md)、[子 agent](subagents.md)、[使用与会话](usage.md)、[设置](settings.md)、[快捷键](keybindings.md)。
