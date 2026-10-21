# 使用与编写扩展

[English](../extensions.md) · [日本語](../ja/extensions.md) · [文档首页](../../README.zh-CN.md)

扩展可以添加工具、命令和界面行为。安装的包可以包含多个扩展、skill 和顶层 CLI 命令。扩展会以你的权限在本机运行代码。

本页说明本地扩展的使用。[远程工作区](remote-workspaces.md)只运行内置可执行扩展：已安装或显式配置的可执行扩展会被跳过并显示通知，本地安装的扩展也不会在远程前端执行。远程仍可发现可信包中的 skill 数据。附加界面不提供 `/ext` 和 `/provider` 管理；安装包不会让其中的工具、命令或自定义视图获得远程支持。

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

这些命令支持多个包名或来源。更新时不指定名称，会更新所选范围内的全部包；安装时不指定来源，会按该范围的锁文件恢复缺失的包。禁用会保留包和锁定记录，删除则移除两者。安装、更新和删除支持 `--quiet`（只输出结果和警告）和 `--json`（每行一个结果对象）。

安装和更新时，`experimental` 包会显示提示，`wip` 和 `deprecated` 包会显示警告。`--quiet` 隐藏实验性提示，但保留警告；`--json` 会输出单独的 `type: "status"` 事件，其中包含结构化的 `status` 对象（`kind`，以及可选的 `message` 和 `replacedBy`）；结果事件的 `status` 仍表示原有的操作结果。`amira ext list --json` 返回数组，其中受影响的包带有相同结构的状态对象。

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

`/ext` 无需离开会话就能完成同样的操作。不带参数时，它打开一个列表：先是已安装的包（显示作用域、是否启用、是否受信任，以及索引中是否有新版本），然后是索引中可安装的包。在已安装的包上按 Enter 可以打开设置（已加载扩展声明设置时才显示）、更新、启用或禁用、删除、查看详情；在可安装的包上按 Enter 会询问安装到用户作用域还是项目作用域，然后安装。按 `d` 查看详情。列表中的按键见[快捷键](keybindings.md#对话框)。

```text
/ext
/ext config hello-extension
/ext search lsp
/ext install todo
/ext install todo --project
/ext update
/ext disable todo
/ext remove todo --project
```

`install`、`remove`、`disable` 和 `enable` 只接受一个包名；`update` 可以接受任意数量的包名，不带包名时更新该作用域的全部包；`--project` 为 install、update 和 remove 选择项目作用域。规则与 CLI 相同：安装到项目中的包仍需信任该项目才会加载，disable 和 enable 通过用户设置同时作用于两个作用域。安装和更新时会显示进度面板，期间可以继续输入。Esc 或 Ctrl+C 取消正在进行的操作并保留草稿；安装要么完整完成要么不生效，已经完成的更新会保留。

`/ext` 不会自动重新加载扩展代码。包有改动时，它会提示运行 `/reload`，或在当前轮次结束后再运行；保存设置则立即通知扩展，无需重新加载。`/ext` 操作进行中时 `/reload` 会拒绝执行。安装到未受信任项目的包，要等下次启动时信任该项目，或运行 `amira ext trust` 并重启后才会加载。打印模式和 RPC 模式中可以用带引号的斜杠命令执行这些子命令；列表需要交互界面。

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

包通过 `amira-package.json`，或 `package.json` 内的 `amira` 对象描述其内容。扩展、skill 和主题路径必须位于包目录内。清单支持以下字段：

| 字段 | 用途 |
| --- | --- |
| `name` | 小写 npm 风格的包名 |
| `version` | Semver 版本，省略时默认 `0.0.0` |
| `engines.amira` | 支持的扩展 API 版本范围 |
| `extensions` | 扩展模块路径 |
| `skills` | Skill 目录路径 |
| `themes` | 主题 JSON 文件路径，默认为 `[]`（见[主题](themes.md)） |
| `commands` | 顶层 CLI 命令名到模块的映射 |
| `status` | 可选：`experimental`、`wip` 或 `deprecated` |
| `statusMessage` | 可选的状态说明 |
| `replacedBy` | 可选的替代包名称；仅在状态为 `deprecated` 时使用，其他情况下忽略 |

版本范围针对扩展 API，而不是 CLI 发布版本。[公共 API](../../packages/api/src/index.ts) 导出的 `API_VERSION` 是当前版本。未指定扩展列表时，Amira 依次查找 `index.ts` 和 `src/index.ts`；只提供 CLI 命令或主题的包可以不带扩展入口。

### 扩展状态

状态元数据均为可选。在 `package.json` 中，将它们放在 `amira` 对象内，即 `amira.status`、`amira.statusMessage` 和 `amira.replacedBy`；在 `amira-package.json` 中，使用同名的顶层字段。`experimental` 表示实验性包，`wip` 表示仍在开发中，`deprecated` 表示不再推荐使用的包。用 `statusMessage` 补充说明，弃用包可用 `replacedBy` 指定替代包。

未知状态会被忽略，并产生清单警告。状态元数据及其警告不会阻止安装或加载；`replacedBy` 不会自动安装替代包。

`index.json` 的每个条目也可以在顶层提供相同的可选字段 `status`、`statusMessage` 和 `replacedBy`（不嵌套在 `amira` 中），以便在安装前的查找过程中显示状态。允许的状态值和 `replacedBy` 的使用限制相同。索引状态会在下载前提示；已安装包的元数据优先采用清单中的有效状态。清单没有有效状态时，索引元数据会保存在锁文件中，供离线列表和设置页使用。

`amira ext list`、`/extensions` 和扩展设置页面会显示状态徽标。会话启动时，以及使用扩展自身的命令或视图时，不会显示状态提示。

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
  const settings = api.settings.declare({
    fields: [
      { key: "message", type: "text", label: "Greeting", default: "Hello from an extension.", maxLength: 120 },
    ],
    preview: (draft) => ({ lines: [{ kind: "text", text: draft.message }] }),
  })
  settings.onChange(() => api.requestRender())
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
      ctx.print(settings.get().message)
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

运行 `/ext config hello-extension` 可以在实时预览中编辑问候语。保存后，下次 `/hello` 立即读取新值，无需重启。开发独立文件时，也可以运行 `amira --extension ./hello-extension/index.ts`，直接加载文件而不安装清单。该选项可重复，相对路径以命令启动目录为准。Amira 在运行时提供 `@amira/api` 导入，独立文件也无需另行安装这个运行时包。

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
| `registerView` | 注册全屏或停靠视图类型，命令在前端支持时通过 `openView` 打开 |
| `registerToolRenderer`、`decorateToolRenderer` | 展示工具调用和结果，或包装已有展示器 |
| `serverToolView` | 将 provider 托管的工具块（如原生网页搜索）转换为与展示器共用的工具调用视图形状 |
| `registerMarkdownRenderer`、`registerImageProvider` | 渲染回复中匹配的代码块、数学公式或独立图片，并提供终端图片数据 |
| `provideService`、`useService` | 共享具名服务；使用时再查找，提供方可能未加载或已卸载 |
| `settings.declare` | 声明有序设置字段和可选的隔离预览，通过 `get()` 读取类型化值，通过 `onChange()` 订阅保存后的变化 |
| `settings`、`cwd`、`home`、`apiVersion` | 读取合并后的设置、每个顶层键的来源层、工作目录、用户目录和 API 版本 |
| `dataDir` | 必需的只读绝对路径，指向本扩展的持久状态目录，首次访问时创建 |
| `backgroundJobs` | 启动并查看本扩展自己启动的后台任务；内置前端代码使用仅供 host 使用的 `hostBackgroundJobs()` 能力 |
| `runCommand`、`openPipe`、`onExit` | 运行受管理的子进程、启动长期管道进程，或注册短时退出工作 |
| `onUnload` | 注册卸载、重载和退出时的同步清理 |
| `notify`、`reportError` | 显示提示或报告后台错误 |
| `registerFileRestoration` | 接管回退时的文件恢复（例如 checkpoints 扩展）：选择器显示你提供的选项，core 不再恢复文件；同一时间只能有一个扩展接管，卸载时释放 |

### 卸载清理

用 `api.onUnload(() => { ... })` 清理自行创建的资源，例如定时器、订阅或用于中止待完成工作的 `AbortController`。它返回一个移除该钩子的函数。每个已注册钩子在此实例卸载时调用一次：包括 `/reload`、禁用或移除生效、加载失败后的回滚，以及退出。停靠和全屏视图先关闭，在注册项仍可用时各调用一次 `onClose`；然后执行卸载钩子，最后移除注册项。钩子失败会被报告，但不会中断其他清理。

清理是同步的，不等待返回的 Promise。必须在卸载期间完成的持久化请使用同步操作；仅在退出时需要的、有时间限制的异步工作请使用 `api.onExit`。退出钩子先于卸载清理执行。

```ts
const pending = new AbortController()
const timer = setInterval(refresh, 1000)
api.onUnload(() => {
  pending.abort()
  clearInterval(timer)
})
```

### 声明扩展设置

使用 `api.settings.declare(...)` 声明一次设置。宿主决定扩展身份：已安装包写入 `extensions.<包名>.<键>`，独立文件在 `extensions` 下使用宿主已知的绝对路径作为键（Windows 上统一为小写）。命令别名不会改变存储身份。同一身份只能声明一次，重复声明会导致加载失败。字段顺序就是页面顺序。`settings.get()` 返回只读、经过校验的对象，键和值的类型自动推导；缺失或无效的文件值回退到声明的默认值。无效值按现有设置问题的方式报告，包含文件和键。

```ts
import { defineExtension, type MarkdownRenderContext, type MarkdownRenderResult } from "@amira/api"

export default defineExtension((api) => {
  // 与实际渲染器共用纯函数，始终显式传入设置。
  const renderSample = (
    mode: "text" | "image",
    size: number,
    ctx: MarkdownRenderContext,
  ): MarkdownRenderResult => ({
    lines: [{ kind: "text", text: `Sample: ${mode}, ${size}px (${ctx.width} columns)` }],
  })
  const settings = api.settings.declare({
    fields: [
      { key: "size", type: "number", label: "Size", description: "Font size in pixels.", default: 16, min: 8, max: 64, step: 1 },
      { key: "mode", type: "choice", label: "Mode", default: "text", options: ["text", "image"] },
      { key: "enabled", type: "toggle", label: "Render samples", default: true },
      { key: "colour", type: "colour", label: "Colour", default: "#88aaff" },
    ],
    preview: (draft, ctx) => renderSample(draft.mode, draft.size, ctx),
  })
  settings.onChange(() => {
    // 如有扩展自己维护的渲染缓存，在此使缓存失效。
    api.requestRender()
  })
  api.registerCommand({
    name: "sample",
    description: "Print the saved sample settings",
    run(_args, ctx) {
      const values = settings.get()
      ctx.print(`${values.mode}: ${values.size}px`)
    },
  })
})
```

五种字段类型：`number`（可选 `min`、`max`、`step`）、`toggle`、`choice`（`options` 为字符串或 `{ value, label?, description? }`）、`text`（可选 `placeholder`、匹配整个值的 `pattern`、`maxLength`）和 `colour`（`#rrggbb`）。每个字段必须有扁平的 `key`、`type`、`label`、`default`，`description` 可选。声明时校验默认值和约束。有效保存值发生变化时，设置页面或宿主设置重新加载会触发 `onChange`；它返回取消订阅函数，卸载时自动清理。使用时调用 `get()`，或在回调中更新扩展状态。这并不意味着自动监听文件：手动编辑文件后，由宿主设置重新加载（`/reload`）读取。

文本的 `maxLength` 按 Unicode 码点计数，而不是 UTF-16 代码单元：`🚀` 计为一个，`e` 加组合重音计为两个。编辑只在码点之间截断，默认值、文件值和保存草稿中的未配对代理项都会被校验拒绝。`onChange` 回调可以是异步函数；同步抛出的异常和返回 promise 的拒绝都按扩展错误报告。保存和其他通知不会等待异步回调完成。

预览可选。回调收到草稿和渲染上下文（`width`、`theme`、`images`、`maxImageRows`、`signal`），返回现有的 `MarkdownRenderResult`：带样式的 `lines`、行内 `segments`，或带 `alt` / `fallback` 的 `image`。可以返回 promise，例如异步生成的 KaTeX 图片。宿主在结果到达后重绘，替换草稿或关闭页面时中止旧预览；即使回调忽略 signal，也不会显示过期结果。通过显式传入设置，与真正的渲染器共用渲染函数。这比临时向普通 Markdown 渲染器注入草稿更简单、安全：保存值的读取、通知、普通渲染和缓存都不会接触未保存草稿。预览回调不能修改扩展的普通渲染状态。

`/ext` 中，已加载且声明设置的包提供 **Settings** 操作；声明设置的独立文件列在单独的 **Standalone** 分组中，只提供 **Settings** 和 **Show details**，不提供包的安装、更新、移除操作。`/ext config <name>` 直接打开页面，config 补全也包含独立文件名称。宿主从不含扩展名的文件名生成名称，将 ASCII 字母、数字、`_`、`-` 之外的连续字符替换为 `-`（例如 `my extension.ts` 变为 `my-extension`），空名称使用 `extension`。与其他文件或包名重名时，按绝对路径顺序追加 `-2`、`-3` 等后缀。使用 `/ext` 显示的名称，或用引号包住绝对路径：`/ext config "/path/to/my extension.ts"`、`/ext config "C:\\extensions\\my extension.ts"`。也支持单引号，反斜杠保持原样。加载文件或已安装包发生变化时别名可能改变，但保存的设置始终使用原始路径身份。预览位于控件上方，没有预览则只显示控件。上下键移动焦点，左右键或 `-` / `+` 按步长调整数字，输入数字设置值并限制在范围内，左右键循环选项，空格切换 on/off。文本和颜色是单行输入。焦点行显示自动换行的说明。`ctrl+r` 将当前行重置为默认值，标记指出哪些值不同于默认值。

修改只更新预览，不写文件。Enter 在页面内询问保存到用户还是项目设置，默认选当前来源层（未设置时选用户）；再次 Enter 才保存到该层，保留其他键以及现有设置写入器支持的格式。Esc 丢弃整个草稿。优先级更高的 project-local 或命令行值可能仍覆盖保存的用户/项目值；页面显示来源，便于明确选择。

### 扩展状态目录

D111 为 `ExtensionAPI` 增加必需的 `readonly dataDir: string` 属性。`api.dataDir` 是位于 `<api.home>/extension-data/<经过清理的宿主已知身份>` 的绝对路径。目录名由确定性的可读短名称（slug）和原始身份的 SHA-256 哈希组合而成，因此清理后短名称相同的身份仍能区分。宿主传给 `loadFile` 的显式名称（已安装包的名称）决定身份；否则文件加载使用绝对路径（Windows 上统一为小写），而不是文件名或显示标签。直接加载时若没有显式名称，则默认使用来源。同一个已安装包内的所有扩展模块共用此目录，扩展不能自行选择所属身份。

宿主在首次访问 `api.dataDir` 时创建目录；从不访问它的扩展不会创建目录。卸载或重新加载不会清除内容；删除该目录即可重置扩展的存储状态，重新加载后的首次访问会重新创建。请将它用于扩展状态，例如缓存和内部记录，而不是用户文件或项目输出。

只有明确声明 `traits.writesFiles: "paths"`、提供 `getWrittenPaths`，且写入路径报告并集中的每条路径都安全地位于自身 `api.dataDir` 内的扩展工具，才能免除受保护写入审批。注册在内置文件工具名称下的工具，其路径并集还包括参数中指明的路径。报告遵循文件工具的路径语义：相对路径以调用方 agent 的 `cwd` 为基准，而不是 `api.dataDir`。混合目录内外路径的报告不会获得部分豁免，整个调用仍按普通受保护路径规则检查，包括目录外路径。报告缺失、无效，或路径解析未知、不安全时，会请求审批，而不会授予豁免。

包含关系通过原生文件系统对现有路径前缀解析真实路径（realpath）来判断，而不是只比较字符串前缀；新文件可通过已有的父目录进行检查。`extension-data` 命名空间或所属扩展目录被重定向时，即使目标仍在用户目录内，也不能获得豁免；`api.home` 本身是符号链接则允许。符号链接或 junction 导致的目录逃逸，以及有歧义的 Windows 路径形式，都不符合豁免条件。符号链接后跟 `..`，或在处理 `..` 前无法安全解析其父目录时，会请求审批，而不是信任规范化后的路径。

这只免除外层 Amira 用户目录的保护。Git 元数据、`.gitmodules`、配置的 hooks 路径和目录内的 `.amira` 仍需审批。plan 模式仍拒绝写入；shell 权限规则和拦截器的审批请求不变，子 agent 使用相同策略。路径报告是受信任的扩展声明，不是 shell 沙箱、无竞态的授权或独占所有权证明：目录外的硬链接可能指向同一文件。自定义工具必须按文件工具的语义一致地解析报告和实际文件访问。参见[权限](usage.md#权限)。

### 工具结果与展示器行

工具结果的 `content` 是发给模型的文本或图片。可选的 `details` 保存展示器所需的结构化数据，默认只在当前运行中保留。在结果上设置 `persistDetails: true`，即可将这些数据的 JSON 快照保存在会话历史中，供恢复后的对话记录和 `/agents` 使用。内置 provider 序列化器不会将 details 发给模型。

每个结果最多持久保存 **16 KiB（16,384 字节）的序列化 UTF-8 details**，计入 JSON 引号和转义字符。超出上限，或无法序列化的值（如循环引用或 `BigInt`）会被**丢弃，而不是截断**。实时展示器仍能收到原始 details；历史记录则回退到已保存的结果文本或输出文件的预览。因此，`content` 必须在没有 details 时也能表达结果。旧会话仍可加载；`ask_user` 不会从旧记录的文本中推断所选选项。

工具展示器、全屏视图的 `ViewLine` 和块级 Markdown 渲染器共用 `ToolLine`。除 `kind` 和 `text` 外，每行还可以设置：

- `wrap: true`：按可用列数换行，而不是截断文本。
- `marker: "success" | "unchecked"`：在文本前显示主题中的成功或未选中标记，ASCII 主题也适用。标记只出现一次，续行与标签文本对齐。成功标记使用成功颜色，未选中标记使用弱化颜色，标签颜色由 `kind` 决定。
- `description: string`：以弱化样式显示说明；同一行放得下时跟在标签后，否则在标签下换行。每个逻辑行的说明只出现一次。

标记和说明也会启用换行，因此选项行无需另外设置 `wrap`。例如，`{ kind: "text", text: "Patch", marker: "success", description: "Fix it in place", wrap: true }` 显示一个已选选项，标签使用正常文本颜色，说明使用弱化样式。这些字段只描述显示内容，不改变发给模型的工具结果。Core 对 Markdown 渲染器的说明和文本进行相同的清理；块级行数上限保持不变。

### Markdown 与数学公式渲染器

`api.registerMarkdownRenderer({ id, match, render })` 接管回复中已完整的节点。代码围栏使用 `match: { codeLang: ["latex", "tex"] }`，独立图片使用 `{ image: true }`，公式使用 `{ math: "inline" | "display" | "both" }`。公式节点为 `{ type: "math", display: boolean, source: string }`，source 不包含定界符。渲染器先按优先级从高到低运行，同优先级按注册顺序运行。返回 undefined、抛出异常或返回无效结果时继续尝试下一个渲染器；无人接管时，原有 Markdown 显示保持不变。

块级公式使用 `$$…$$` 或 `\[…\]`，可以跨行；独占一行的 `$$` 开始一个块。与被接管的代码围栏一样，流式输出期间显示源码，收到结束定界符后才交给渲染器。回复结束时仍未闭合的公式继续显示源码。段落内的行内公式使用 `$…$` 或 `\(…\)`，代码跨度和代码块内不识别公式。起始美元符号后不能紧跟空白，结束美元符号前不能是空白、后不能紧跟数字；`\$` 表示字面美元符号，因此 `$5 and $10` 这样的货币文本不会被识别为公式。

行内公式必须返回 `{ segments: [{ kind: "text", text: "x²" }] }`，这些带样式的文本片段会拼入段落并随段落换行；行内图片和块级 lines 结果会被拒绝。块级公式、代码围栏和独立图片返回 `{ lines: ToolLine[] }` 或 `{ image: ImageInput, alt?: string, fallback?: ToolLine[] }`。alt 描述图片，fallback 提供可读的文本呈现。无法显示图片、复制或打印对话时优先使用 fallback，其次使用 alt；两者都没有时回退为原节点。Core 移除渲染文本中的转义和控制序列，并将块级结果限制为 2000 行。

渲染上下文包含 width、images、maxImageRows 和 `theme: { dark: boolean, foreground?: string, background?: string }`。执行图片工作前请检查 images。纯文本 `amira -p` 将已完整的节点交给同一注册表，设置 `images: false`，无人接管的源码保持原样；此时应返回文本。带 fallback 或 alt 的图片结果会转换成文本。渲染器在 `waitMs` 内没有回应时会被跳过，改为输出源码。`--json` 保留原始事件，不运行渲染器。

TUI 启动时通过终端背景探测选择明暗主题（优先 OSC 11，其次 COLORFGBG，默认深色），整个会话期间保持不变。渲染上下文使用同一选择，单色模式也如此。目前无法确定准确的前景色和背景色，因此省略这两个字段。非交互打印模式默认使用 `{ dark: true }`。渲染缓存的键包含主题。全屏回复在异步结果到达时重绘，此前显示 Amira 的渲染结果。`MarkdownRendererDefinition.waitMs` 已弃用，TUI 忽略此字段，但为兼容性保留；打印模式仍按上文所述使用它。行内公式应同步返回 segments。

### 命令回显

命令默认会将输入的 slash 命令行回显到对话记录中。在传给 `api.registerCommand()` 的 `CommandDefinition` 上设置 `echo: false`，即可在全屏 TUI 中省略这一行，例如用于 `/btw <question>`。这只隐藏前端的输入回显：命令自身的输出（`ctx.print`、通知和视图）仍照常显示，输入历史（↑）也仍会记录该行。打印模式和 RPC 的行为不变。

### 全屏与停靠视图

通过 `api.registerView()` 注册 `ViewDefinition`，命令用 `ctx.openView?.({ kind, data, state })` 打开它，可选的 `state` 为初始 `Partial<UiState>`。视图返回结构化的 `ViewLine` 对象；前端负责终端、换行、滚动、输入提示和确认。`subagent` 类型和 `/agents` 命令由内置 agent 扩展注册。没有加载该扩展时，从对话中的子 agent 块打开视图会提示实时视图不可用。

终端能传递 F6 时，F6 在所有视图与主输入框之间切换焦点，包括默认视图。可配置的 `view.focus` action 默认绑定为 `["f6", "ctrl+tab"]`；终端能传递 Ctrl+Tab 时，它也是别名，但 Windows Terminal 可能截获它，旧式终端可能将其报告为普通 Tab。F6 可避开这些 Ctrl+Tab 问题，但 VS Code 集成终端默认会截获 F6，因为 `terminal.integrated.commandsToSkipShell` 中包含 `workbench.action.focusNextPart`。可在 VS Code 设置的 `terminal.integrated.commandsToSkipShell` 中添加 `"-workbench.action.focusNextPart"`，或将 Amira 的 `view.focus` 重新绑定到终端能传递的按键。单独的 Shift+Tab 不能绑定到 `view.focus`；它保留用于权限模式切换和视图反向导航。默认视图仍可用 Tab，提示继续显示 `tab→input/view`，不显示 F6。设置 `ViewDefinition.needsTab: true` 可保留 Tab/Shift+Tab 用于组件导航或视图快捷键；默认焦点提示显示 `f6→input/view`，而不是 Ctrl+Tab。宿主焦点切换从不占用 Shift+Tab。内置子 agent 视图声明此选项。`/`、`i`、可打印键路由、Esc 和焦点样式见[扩展视图](keybindings.md#扩展视图)。已激活的视图内输入框和输入提示仍接收自身输入。

`title(data, opts)` 返回 `string | ViewLine`，作为第一行。字符串保留默认的 `◆`
标记；语义化的 `ViewLine` 提供完整标题，前端不会自动添加标记。两种形式都会由前端
截断到标题的可用宽度。`titleAside(data)` 在其右端追加一段简短文字，如 `2 of 5`，
这段文字保持完整。

`ViewLine` 支持语义化内容，不使用 ANSI 转义码，样式由前端负责：

- `{ kind: "segments", parts: ViewSegment[] }` 将带样式的文本组合为单行，超出宽度时
  由前端截断，不换行。导出的 `ViewSegment` 类型为
  `{ text: string, kind: "text" | "dim" | "muted" | "accent" | "success" | "warning" | "error" }`。
- `{ kind: "user-message", text: string, note?: string }` 使用与对话中用户消息相同的显示方式，
  包括换行、背景和间距。只需提供消息文本，不要手动添加 `›` 标记。可选的备注显示在
  消息下方，与消息共用同一背景。

`ViewRenderOptions.statusBadge?(state: AgentStatusState, options?: { pad?: boolean }): ViewSegment[]` 是宿主提供的 agent 状态徽标辅助函数。`UiContext` 通过 `ViewRenderOptions` 继承它，因此声明式视图也可以使用。从 `@amira/api` 导出的 `AgentStatusState` 类型支持 `queued`、`working`、`idle`、`paused`、`done`、`failed` 和 `stopped`。宿主负责主题符号、ASCII 替代以及共用的旋转指示器时序和重绘。queued 使用暗淡样式，working 使用强调色，idle 使用弱化色，done 使用成功色，failed 使用错误色，stopped 和 paused 使用警告色（见[状态徽标图例](subagents.md#状态徽标图例)）。

将返回的片段直接插入语义化行，例如视图标题：

```ts
import type { ViewLine, ViewRenderOptions, ViewSegment } from "@amira/api"

function taskTitle(opts: ViewRenderOptions): ViewLine {
  const fallback: ViewSegment[] = [{ kind: "accent", text: "working" }]
  return {
    kind: "segments",
    parts: [
      ...(opts.statusBadge?.("working", { pad: true }) ?? fallback),
      { kind: "text", text: " Task" },
    ],
  }
}
```

`AGENT_STATUS_BADGES` 是导出的显示表，以 `AgentStatusState` 为键。每项包含 `{ symbol, ascii, role, label }`：默认 Unicode 符号、ASCII 替代符号、语义主题角色和明确的状态词。例如，`AGENT_STATUS_BADGES.stopped` 为 `{ symbol: "‖", ascii: "|", role: "warning", label: "stopped" }`。宿主辅助函数还会应用主题覆盖和动画。`{ pad: true }` 将状态词补齐到七个单元格，使任务名对齐；默认不补齐。

请将完整的 info/result 传给 `agentStatusState(agent)`，而不只是 `agent.status`，以保留提前结束的备注。导出的 `AgentStatusSource` 类型也支持旧状态字符串和对话树节点。共用映射把 `done` 加任何已定义的提前结束 `note`（包括空字符串）解释为 `stopped`；用户暂停中的活动轮次解释为 `paused`，不会显示为 `working`。这不会改变生命周期结果的契约。扩展中需要对齐的行可调用 `opts.statusBadge?.(agentStatusState(agent), { pad: true })`。按名称导入该函数或显示表，需要宿主构建已导出它们。可选辅助函数只保护前端缺少该方法时的调用，不会让缺少命名导出的旧宿主能够加载这些导入。若要支持旧版宿主构建，请使用下例的命名空间导入和功能检测。这些能力自 API 0.1.48 起提供；仍建议做功能检测。

```ts
import * as amira from "@amira/api"

function displayState(status: amira.SubagentState, note?: string, paused = false) {
  if (typeof amira.agentStatusState === "function") {
    try {
      if (amira.agentStatusState({ status: "done", note: "" }) === "stopped")
        return amira.agentStatusState({ status, note, paused })
    } catch {} // An older host may accept only strings.
  }
  if (status === "done" && note !== undefined) return "stopped"
  if (status === "running" && paused) return "paused"
  if (typeof amira.agentStatusState === "function") return amira.agentStatusState(status)
  return status === "running" ? "working" : status === "error" ? "failed" : status === "aborted" ? "stopped" : status
}
```
`ctx.ui.choose()` 还接受与选项一一对应的 `optionStatuses?: (AgentStatusState | undefined)[]`；宿主在这些选项前显示相同的徽标，不改变返回的选项字符串。若要在选择器打开时跟踪生命周期变化，可传入仅在宿主运行的 `live()` 回调，返回 `{ optionLabels?, optionStatuses?, descriptions? }`。这些显示数组沿用原选项顺序；`optionLabels` 只决定显示文本，原始 `options` 仍是稳定的回答标识。显示变化通过相同 `requestId` 的 `ui.request` 发布。前端和 RPC 客户端必须原位更新现有请求，不能新开选择器或重置选择、筛选和滚动位置。回调不序列化，请求关闭时取消订阅。

视图按键支持单个可打印字符，以及 `left`、`right`、`tab`、`shift-tab`。标签相同的
按键在底部提示中合并为一项（`←→ switch`）；标签为空的按键（例如另一个按键的别名）
不出现在底部提示中。Esc、q、Ctrl+C 和滚动按键仍由前端处理。按键处理函数通过 `ViewControl` 关闭视图、
请求重绘、调用 `print(text, level?)` 打印快照，或请求输入、确认。打印等级与命令输出
一致：`info`、`warning`、`error`。若要立即返回对话，先关闭视图再打印。

`scrollKey(data)` 返回当前子 agent 或标签页的 id。前端为每个 id 保存滚动位置及
跟随末尾的状态，直到视图关闭。不提供该函数时，视图共用一个滚动状态。
`follow: false` 让每个新 id 从顶部开始显示。

通过 `api.session()` 读取实时快照，通过 `api.on()` 订阅事件；状态变化后调用
`api.requestRender()`。静态视图没有刷新定时器。若内容随时间变化，请在绘制回调中调用 `opts.requestRefresh?.(1000)`（声明式视图使用 `ctx.requestRefresh`），且仅在时间能够改变显示时调用。每帧中最短的正数有限间隔生效；刷新需求每帧重置，没有刷新或动画需求时定时器停止。被覆盖或高度为零的停靠视图会暂停刷新需求，重新可见并绘制时再计算；静态或被裁掉的选择器和命令行不会维持时钟，可见状态转为 working 时重新启动。working 徽标和运行中的工具会自动请求共用的旋转指示器频率。`header` 和 `render`
接收可用宽度、当前时间，以及可选的 `renderTool(toolName, call, detail)` 回调。
该回调使用 host 当前的工具 presenter 和通用渲染器；传入 `ToolCallView`，直接返回
得到的行以保留 host 的显示效果。其他前端可能不提供该回调，因此应提供纯文本行的
回退实现。API 0.1.15 增加了这些视图能力。

D105 增加宿主管理的页面，无需注册另一种视图：调用 `view.pushPage({ title?, state?, data? })` 和 `view.popPage()`。推入页面后，render 和 ui 上下文包含 `page: { depth, data? }`，depth 从 1 开始；根页面不提供 page，回调的第一个参数仍为原视图数据。可选的页面标题替代旧式标题，或在声明式正文上方增加一行标题。每页独立保存选中项、展开项、标签页、输入、焦点和滚动状态，包括旧式 `scrollKey` 位置；弹出页面后恢复上一页。Esc 先取消当前提问，否则弹出页面，在根页面则关闭视图；宿主按键栏在子页面显示 `Esc back`，在根页面显示 `Esc close`。Ctrl+C 始终关闭整个视图，即使正在输入或确认；q 保持原有行为。切换页面会取消尚未回答的提问。

可选的 `onOpen(data, control)` 和 `onClose(data)` 在每次打开和关闭时各调用一次，重绘及页面切换不会触发。初始状态在 onOpen 之前应用，onOpen 可调用 setState 或 close。同一扩展实例使用同一注册项再次打开已显示的同类型视图时，只替换数据，不关闭或重新打开；未提供显式初始状态时保留状态，提供初始状态则从新的根页面开始。替换为其他类型或扩展实例会关闭原视图，并挂载新的查看器。打开视图的扩展或提供该视图的扩展卸载时，其停靠和全屏视图会在移除注册项前关闭；保留的旧命令上下文无法在卸载后重新打开视图。

### 旁支问题：临时子 agent、停靠视图与显示块

`SpawnOptions.ephemeral?: boolean` 创建只存在于内存中的子 agent，并自动启用 persistent（即使传入 `persistent: false`）。保留 `ChildSession`，通过 `send(text)` 发送追问；`stop()` 在当前轮结束后停止，`abort()` 立即停止。父会话退出或切换时也会中止它。它及其后代不生成会话或输出文件，不记录父会话的 `subagent` 条目，不出现在公共列表或主对话事件中；流式内容通过 `child.events` 读取。用量计入 agent 树，并像 `api.complete` 一样保存为所属会话的 `side_usage`（首次写入会话前暂存）。临时/persistent 子 agent 不能使用 schema 结果。

`SpawnOptions.callableTools?: string[]` 限制本地执行，不删除或重排本地工具声明。被拒绝的本地调用在执行或审批前返回简短工具错误。provider 托管工具在远端执行，因此被排除的工具**不会加入请求**，而不是返回本地错误。OpenAI Responses、Anthropic 和 Gemini 的内置托管搜索共用名称 `web_search`（包括 Gemini 的 Google Search）；加入此名称即可允许使用。省略列表则不限制工具。此限制也适用于子 agent 的压缩请求及审批/提问咨询。后代不能扩大继承的调用权限。

为保留 fork 的**本地**工具声明，请使用 `callableTools` 而不是 `tools`/`excludeTools`：临时子 agent 保留 `mainOnly` 声明，但不能调用。fork 按父会话的顺序复制已加载的 deferred 工具；尚未加载的仍不提供。排除托管搜索会移除其声明，也可能将继承的托管结果转换成文本，因此完整请求/缓存前缀不再与提供托管搜索的父会话相同。角色指令、按会话运行的拦截器、不同模型、子 agent 专属工具及对父会话未完成调用的裁剪，也可能改变前缀。

临时子 agent **不绕过 `maxConcurrent`**、深度、分组限制或 token/费用预算。当树的并发上限至少为 2 时，普通子 agent 最多占用 `maxConcurrent - 1` 个忙碌位置，为临时子 agent 的首轮或追问保留一个位置。临时工作也可使用其他空闲位置，但不能超过总并发上限或分组上限。`maxConcurrent: 1` 时仍正常排队。spawn 返回后立即读取 `child.state === "queued"`，以显示首轮等待状态。初始 `subagent.start` 事件在 `spawn()` 返回前发出，不会向新订阅者重放。订阅 `child.events` 可接收后续的 `subagent.state` 变化，包括追问排队。空闲子 agent 会释放并发位置。咨询用量（包括失败尝试和重试）以咨询模型的身份保存为发起请求的临时子 agent 的 `side_usage`。

使用 `ctx.openView?.({ kind, data, placement: "dock", maxHeight?: number })` 打开停靠视图；省略 placement 时仍为全屏。高度包含标题、header 和底部按键栏，默认约为终端可用行数的 40%，至少 5 行（输入区域留下不足 5 行时除外）。TUI 在保持焦点的输入框正上方显示实时区域，使用当前主题和边距。配置的 `scroll.page-up`/`scroll.page-down` 按键滚动停靠视图（默认 PgUp/PgDn）；鼠标滚轮只在指针位于该区域时滚动它；`scroll.bottom` 恢复跟随末尾（默认 End）。停靠视图默认聚焦主输入框；有可选择内容时，F6 进入停靠视图（终端能传递 Ctrl+Tab 时，它也是别名）；未声明 `needsTab: true` 时也可用 Tab。停靠视图获得焦点时，组件和扩展快捷键接收相应按键。只读停靠视图不取得焦点，保持原有滚动行为。停靠视图的 prompt/confirm 会取消，不替换主输入框。停靠视图获得焦点时，Esc 返回或关闭视图；主输入框为空时，Esc 将焦点返回有可选择内容的停靠视图，与全屏视图相同。主输入框有文本时，Esc 仍关闭停靠视图并保留草稿。历史搜索优先处理：Esc 先取消搜索并恢复草稿；主输入框为空时，再按 Esc 返回视图或有可选择内容的停靠视图。只读停靠视图仍先关闭，再取消命令或中断当前轮。对话框可见时，只允许在停靠区域上使用滚轮滚动；点击不会聚焦停靠视图或选择内容。覆盖其上的全屏视图和表单保留原有按键优先级。`follow`、用于 Markdown 的 `renderReply` 和 `onClose` 与全屏视图共用。

`ctx.print(text, level?, { details?: string; markdown?: boolean; persist?: boolean })` 和 `api.notify(text, level?, options?)` 输出只供显示的块。text 是标题；details 在 summary 时折叠，在 full 时展开（Ctrl+O）。`markdown: true` 将详情渲染为 Markdown。`persist: true` 保存 `display` 会话条目，恢复时按对话顺序重新显示，但上下文构建会跳过它。标题和详情均不会发给模型，包括会话 fork、子 agent fork 和压缩请求。只有显示条目的会话也会在启动恢复时显示。保留的 `ctx.print` 始终绑定到命令运行时的会话，即使停靠视图因会话切换而关闭，也不会写入另一个会话。TUI 保留可折叠的块。打印模式输出标题，RPC 还携带可选的详情字段。

以下 `/btw` 风格示例仅使用公共 API，是文档草图，不是内置扩展。实际扩展还需处理子 agent 已结束、追问未送达以及卸载清理。

```ts
import { defineExtension, type ChildSession, type SpawnGroup, type CommandContext } from "@amira/api"
export default defineExtension((api) => {
  type Side = { question: string; answer: string; child: ChildSession; group: SpawnGroup; print: CommandContext["print"] }
  let side: Side | undefined
  api.registerView({
    kind: "btw", title: (d: Side) => `btw: ${d.question}${d.child.state === "queued" ? " (waiting)" : ""}`, follow: true,
    render: (d: Side, opts) => opts.renderReply?.(d.answer) ?? [{ kind: "text", text: d.answer }],
    onClose(d: Side) { d.child.abort(); d.group.end()
      if (side !== d) return
      side = undefined
      d.print(`btw: ${d.question}`, "info", { details: d.answer, markdown: true, persist: true })
    },
  })
  api.on("session.end", () => { side?.child.abort(); side?.group.end(); side = undefined })
  api.registerCommand({
    name: "btw", description: "Ask a side question", echo: false,
    run(question, ctx) {
      if (side) { side.answer += `\n\nFollow-up: ${question}\n\n`; side.child.send(question); return }
      if (!ctx.openView || !ctx.session.createGroup) throw new Error("Side questions need the TUI and an agent tree")
      const group = ctx.session.createGroup({ name: "Side question" })
      const child = group.spawn({ prompt: question, context: "fork", ephemeral: true, callableTools: ["read", "grep", "glob"], systemPrompt: "Answer this side question; do not change files." })
      const d: Side = { question, answer: "", child, group, print: ctx.print }; side = d
      void (async () => {
        for await (const e of child.events) {
          if (e.type === "message.delta" && e.data.kind === "text") { d.answer += e.data.text; api.requestRender() }
        }
      })().catch((error) => api.reportError(String(error)))
      if (!ctx.openView({ kind: "btw", data: d, placement: "dock" })) { side = undefined; child.abort(); group.end() }
    } })
})
```

### 扩展拥有的持久会话

`api.conversations?: OwnedConversations` 是可选宿主能力，使用前必须检测。不能用临时子 agent 替代它，却声称历史已保存。与 `/btw` 风格的子 agent 不同，owned conversation 有稳定的 owner/key 身份、独立保存的会话和单写者租约。它属于扩展，不属于当前主会话；主会话的 `/clear`、`/resume`、rewind 和 fork 不会停止它或改变其绑定。关闭视图只隐藏内容。TUI 可将焦点切换到此会话，使用同一原生对话记录和输入框，主会话仍在后台继续运行。

- `openOrCreate(spec, runtime): Promise<OwnedConversation>` 打开所属扩展已保存的 key，或创建新会话。`open(id, runtime)` 只能打开该扩展拥有的会话。另一个宿主或进程持有租约时会得到明确的 **in use** 错误。同一扩展实例重复打开会返回现有句柄。两种方法都会拒绝已归档或归档未完成的会话。
- `read(ref: OwnedConversationRef): Promise<OwnedConversationSnapshot | undefined>` 按 owner 范围内的 `{ id }` 或 `{ key }` 读取，不打开可执行句柄。本管理器有活跃句柄时使用其权威实时状态，否则读取经过校验的持久化证据；其他进程持有写入租约时，持久化快照可能滞后，并标记为不完整。只有记录确实不存在时才返回 `undefined`；无效或属于其他 owner 的身份会抛出错误。读取不要求已配置的模型、运行时工具或仍存在的 cwd，不构造 agent、查找模型、重新绑定运行时、取得写入租约、改变焦点、修复目录或请求 provider。已完成归档仍可读取，返回 `archived: true`；归档未完成时拒绝读取，不返回已完成归档的快照。
- `ConversationSpec` 包含 `key`、`name`、绝对路径 `cwd`、可选的 `model`（`provider/model`）、`systemPrompt`、必填的 `callableTools: string[]`，以及可选的 `writeRoots: string[]` 和 `descendants: "research" | "inherit"`。宿主保存此规格；重新打开不能悄悄修改它或扩大工具权限。此类历史独立于普通主会话的列表、resume 和 fork 路径。
- `ConversationRuntime` 包含必填的 `askUser(questions, { sessionId, signal }): Promise<AskAnswer[] | undefined>` 和可选的 `extraTools: ToolDefinition[]`。每次重新打开都要绑定回调与执行函数；它们不序列化。缺少必要工具时拒绝运行。提问直接进入此回调，绝不交给主会话模型回答。回调必须展示真实的人类选择、响应取消，并在返回前保存需要的决策证据。返回 `undefined` 表示取消。
- 创建和重新打开不会发送模型请求、重放未完成轮次、重启子任务或恢复旧问题。扩展初始化期间仍可打开会话，但 owned `send()`、`runTool()`、`complete()` 和 `createGroup()` 会拒绝，直到初始化完成。请在初始化完成后的命令或 `session.start` 处理函数中启动工作；不要在初始化函数内等待就绪，否则会导致启动死锁。只有显式的 `OwnedConversation.send(text, { images?: ImageBlock[], display?: MessageDisplay, signal? })` 才启动一轮，仅发送图片时文本可为空；在该轮结束时完成，重叠的 send/tool/complete 操作会被拒绝。仍使用配置的 AI/provider，遵守宿主限制。
- 保存的 callable allowlist 在审批前限制本地工具执行，并从 provider 请求中排除不允许的托管工具，包括压缩请求。`createGroup(options)` 绑定到此会话。后代继承 callable 和写入上限的交集，即使使用临时子 agent 或额外工具也不能扩大权限。允许工具名意味着信任其实现。
- `descendants` 默认为 `"research"`：子 agent 不能运行 shell 工具、更改 cwd 或准备 worktree，保持现有已保存会话的行为。显式设置 `"inherit"` 后，子 agent 可正常使用 cwd/shell，包括不同 git worktree 的 cwd，但仍共享你的当前权限、所属会话的生命周期和用量统计，并将提问与审批直接交给人类，不向另一个模型咨询人类问题。`ToolSession.restricted` 仍表示仅研究限制。
- `writeRoots` 是不可变的文件工具写入上限，根目录必须是有效绝对路径。省略表示不增加目录限制；`[]` 表示不允许文件工具写入。`SpawnOptions.writeRoots` 省略时继承父会话，指定时只能缩小上限；读取不受此目录限制。宿主在最终参数拦截后、审批和执行前检查全部写入路径，包括删除和 patch 移动的源与目标，并在变更钩子处再次检查。重新计算的路径报告必须一致；变化、越界、无法解析、格式错误或抛错的报告均在审批前拒绝，不会询问；审批、auto 模式和扩展数据目录豁免都不能覆盖此上限。受限写入拒绝多链接（硬链接）目标以及 symlink/junction 逃逸。带策略的元数据和会话头使用旧读取器会拒绝的格式；旧的无限制记录保持原有行为。
- **这不是操作系统沙箱。** 写入上限约束文件工具（`write`、`edit`、`apply_patch` 及声明文件写入/路径能力的工具），不约束任意 shell 子进程、导入的程序或受信任扩展代码。shell 工具仍遵守你的当前权限模式和命令规则。自定义工具必须诚实报告全部写入，并按声明使用变更钩子；恶意并发文件系统变更仍存在竞态，不属于沙箱保证。
- `runTool(name, args, { signal? }?): Promise<ToolResult>` 仅在会话空闲时调用持久化 callable 上限内的工具，不提供 cwd、权限或执行器覆盖。它复用模型工具调用的注册表/宿主启用限制、拦截器、权限上限、参数校验、权限/审批、事件、输出处理和变更钩子，但不请求 provider，也不添加模型历史消息。拒绝、取消、失败或超时都返回错误结果，绝不表示检查成功；请检查 `isError` 及工具的退出/结果详情。`stop()` 和 `release()` 会取消并等待执行器实际结束，即使超过中止宽限期，也保留 busy 状态和租约。取消后变更钩子失效；忽略取消的执行器可能使清理无限等待。与直接 owned 检查不同，普通模型调用仍允许 after 拦截器恢复执行错误；执行权限上限的拒绝仍不可覆盖。工具事件携带所属会话和操作 ID（`turnId` 中的 `o_…`），不伪造模型轮次或人类确认。独立的宿主 custom 记录（`amira.tool-operations`，v1 start/execute/end）保存执行证据。start 保留请求参数；相关联的 execute 记录在执行器派发前持久保存最终授权参数；end 保存结果及取消状态。execute 不代表执行已完成，重新打开不会重放未完成操作。相比之下，`api.runCommand` 仅管理进程，**不执行工具权限检查**：先单独确认再调用 `runCommand`，不等同于 plan 模式拒绝、命令规则或工具拦截器。
- `complete(request: Omit<CompleteRequest, "model">): Promise<CompleteResult>` 使用持久化模型发起一次逻辑上的纯文本旁路请求。如需其他模型，请单独创建使用该模型的 owned conversation。它不使用工具或托管搜索，不注入会话历史，也不在历史中添加模型轮次；操作/label 来源单独保存。包括重试、错误和中止在内的全部已报告尝试均计入此 owner 和 `usage()`，即使你拒绝返回的内容。未报告的用量保持未知，不猜测费用。初始化期间，或与 `send`、`runTool`、另一次 `complete` 重叠时会拒绝；遵守共享准入/全局限制，`stop`、`release` 和扩展卸载会取消并等待其结束。
- `usage(): ConversationUsageSnapshot` 返回累计账目，不是历史消息用量之和。`own` 只含本会话；`total` 将每个可归属后代恰好计入一次。后代行只含其自身用量，不是子树合计；不要把这些行或 runner/group 合计再次加到 `total`。账目包含已报告的重试、压缩（包括失败尝试）、旁路请求、咨询、取消的工作和延迟回执。私有后代可有账目行而无对话记录；旧匿名回执仍保留在其持久化 owner 的 `own` 小计内，不虚构子会话身份。
- 用量和读取快照均深度冻结且可序列化。每份 `AccountedUsage` 保留已知定价小计 `knownCostUsd`，即使 `usage.cost` 缺失；`Usage.pricingUnknown` 和 `complete: false` 保留定价或账目覆盖缺失的状态。未持久化费用仍可见，但标为不完整；缺失或损坏的证据不代表已确认零费用。`complete` 只描述已报告账目/定价的覆盖，不保证覆盖 provider 发票。`revision` 是持久化账目版本，不是事件序号：按版本替换旧快照，不能取费用最大值，因为有符号修正可能降低合计。子 agent/group 结束不代表不会再收到用量。
- `complete` 采用保守判定：只有每个计入的物理请求尝试都有明确且持久化的完整覆盖证据、每个后代引用都已解析、且没有未结束的请求围栏时，宿主才确认完整。已定价小计本身不是完整性证明。证据缺失、格式错误、未报告、未定价或未核对时，快照保持不完整；缺少充分覆盖证据的旧记录也不会被确认为完整。带有已报告小计的明确替换聚合会取代旧账目状态，包括金额不变但覆盖发生变化的更新；终端回执仅省略可选元数据时，保留已知金额，但覆盖仍标为不完整。读取只验证证据，不修复或写入。
- v1 通过保留下来的请求围栏和回执证据处理进程崩溃、撕裂/部分写入、尾部截断及回执丢失。它不是可检测篡改的审计日志：故意删除完整账目事务（包括中间事务）不在保证范围内。全新读取者无法发现仍自洽的整笔事务删除，因此 `complete: true` 不证明会话文件从未被修改。
- `budget.update`、相关完成事件和 `events.lost` 只用于使账目缓存失效，随后调用 `usage()`；不要把共享累计预算载荷当作 owner 账本。先订阅再读取快照，在 release 前及等待工作结束后刷新，release 或重启后通过 `read()` 核对。项目/阶段归属及停止策略由扩展负责；按已报告费用停止可能因在途工作而超支，不保证最大发票金额，也不隔离宿主共享预算。
- 句柄提供 `id`、`key`、`name`、`cwd`、绑定的 `data: SessionData`、`history()`（当前完整分支的不可变快照，包含已被压缩替代的消息）、`status()`（state 和 busy）及 `events: AsyncIterable<AnyEvent>`。`OwnedConversation.events` 包含此会话及普通后代的事件，携带各自的 sessionId，不进入主对话总线。临时后代保留私有总线；扩展必须改用它们的 `ChildSession.events`。先订阅，再读取历史和状态快照。事件不重放；用 history 恢复保存的消息，按 session/turn/tool-call id 关联工具行。
- 绑定的 `SessionData.append(key, data): void` 不提供持久写入确认。磁盘故障通过 `extension.error` 异步报告；`append()` 返回不代表已持久提交。如果决策证据要求持久提交，必须先提交到扩展自行控制的存储，再回答 `askUser` 问题。
- `stop(reason?): Promise<void>` 中止工作、待回答问题和后代，但保留历史；之后可显式 send 继续。`release(): Promise<void>` 停止并等待清理，释放租约，使句柄失效，但不删除历史；重复调用安全。所属扩展卸载、禁用和宿主退出由宿主管理清理，不会中止主会话或其子 agent。`release()` 不会归档会话。不提供删除 API；卸载或移除包后历史仍保留。
- `archive(ref: OwnedConversationRef): Promise<void>` 限于所属 owner，重复调用安全。生命周期状态独立于不可变的 `ConversationSpec` 持久化，使用旧读取器会拒绝的版本化元数据。归档与写入租约争用及进行中的打开操作串行协调：先设置准入围栏，再取消并等待同一 owner 的运行时工作、待回答问题、后代、工具和 `complete` 请求实际结束，使保留的句柄/group 失效，最后才确认已持久归档。其他进程持有写入租约时返回明确冲突，不会直接修改其活跃会话。旧句柄的 `send`、`runTool`、`complete`、`createGroup` 及保留 group 的新任务准入均被拒绝。失效句柄原本有焦点时，焦点返回主会话。
- 崩溃或等待结束/持久化失败可能留下未完成归档，不能视为已完成。重启后仍保持保守拒绝状态：执行、`read` 和 `unarchive` 均拒绝。重试 `archive(ref)` 以完成等待和持久归档。已知限制：如果归档过程中主机被强制终止（例如 SIGKILL），POSIX 上脱离主机存活的后台任务不会跨重启跟踪，重试归档不会停止它们。在途账目可在归档期间结算；最终历史和用量仍可通过无需运行时的 `read()` 读取。
- `unarchive(ref: OwnedConversationRef): Promise<void>` 恢复已完成归档的权限；已处于活动状态的会话保持不变。它只改变生命周期权限。它不打开句柄、启动轮次、重放待处理工作或问题、恢复后代，也不恢复先前的启动批准。需重新打开并绑定新的运行时，再明确批准/启动新工作。由扩展决定取消归档哪些会话；归档不改写策略、移动文件或删除历史。

公共快照类型如下：

```ts
type OwnedConversationRef = { id: string } | { key: string }

interface AccountedUsage {
  usage: Usage
  knownCostUsd: number
  complete: boolean
}

interface ConversationUsageSnapshot {
  sessionId: string
  revision: number
  own: AccountedUsage
  total: AccountedUsage
  descendants: readonly {
    sessionId: string
    parentSessionId: string
    groupId?: string
    ephemeral?: boolean
    usage: AccountedUsage
  }[]
}

interface OwnedConversationSnapshot {
  id: string
  key: string
  name: string
  cwd: string
  archived: boolean
  history: readonly Message[]
  usage: ConversationUsageSnapshot
}
```

`CommandContext.focusConversation?(owned: OwnedConversation): boolean` 聚焦独立会话；`unfocusConversation?(): boolean` 返回主会话。使用前检测这两个方法：仅全屏 TUI 提供；无法切换时返回 `false`（聚焦已释放句柄也会失败）。聚焦或返回都不停止工作，也不释放任何会话；释放已聚焦的句柄或卸载所属扩展会返回主会话。渲染器的保留控制属于宿主内部实现，不是公共扩展 API。

焦点提示显示会话名称、主会话的 `working`/`idle` 状态和待回答的主会话问题。主会话的待处理提示在全屏覆盖层内容上方或下方的预留界面区域保持可见。输入框占位文本以 `Message <owned name>` 标明目标会话。F6（配置的 `view.focus` 绑定）返回主会话；已聚焦会话空闲且输入框为空时，Esc 也返回。工作期间，Esc/Ctrl+C 只停止已聚焦会话，不停止主会话。对话框、补全列表和历史搜索保留按键优先级。草稿、提示词历史、图片附件和粘贴内容按会话隔离；`@` 文件补全使用此会话的 `cwd`。每次切换焦点都会保存原会话草稿并恢复目标草稿，但会重置完整的编辑缓冲区：撤销/重做历史、kill ring 和 yank 状态，包括其中保留的图片和粘贴快照。普通 `setParts` 行为不变。斜杠命令和 skill 会被拦截并提示先返回主会话：输入保留，必须在那里显式执行。

切换前会先取消历史搜索，再保存原始草稿。未完成的括号粘贴在输入归属切换时丢弃，剩余字节会被隔离至结束标记到达，包括超时之后。聚焦独立会话期间，主会话的回退请求（包括延迟的双击 Esc 和保留的 `openRewind()` 调用）会等待；焦点提示显示主会话有待处理事项。返回主会话且主会话就绪后才打开选择器，恢复的提示词只进入主会话草稿。

命令、skill 和输入处理器的 `openView()` 能力绑定到创建上下文时的会话。若延迟打开时焦点已在其他会话，或原主会话已被替换，则返回 `false`，不会接管当前对话记录或输入框。切换焦点只暂停待回答问题的编辑器，不会取消请求；返回时会恢复未完成答案、选择和光标位置。回答或取消请求会释放保存的编辑状态。

切换会话时显示 `— <name> —` 或 `— main —`，使用独立会话名称，绝不显示原始 ID。隐藏期间暂存的新输出可在返回时显示。TUI 显示已聚焦会话保存的对话记录。

`UiRequestOptions.sessionId?: string` 将 UI 请求关联到某个会话（默认关联宿主会话），用于展示和按会话取消审批，不改变执行归属或权限。取消审批只停止所关联的会话，绝不停止无关的主会话或已聚焦会话。所有 UI 请求类型在 RPC 实时/重放的 `ui.request` 事件和 `state.uiRequests` 中均保留此关联，包括请求更新；`ui.resolved` 和 `ui.progress` 在事件封装的 `sessionId` 中保留此关联。RPC 顶层的 `state.sessionId` 仍是主会话 ID。后代请求在元数据中保留子会话 ID；原生宿主会将其映射到所属会话以展示和取消审批，包括聚焦前已经等待回答的请求。将 runtime 提供的 `sessionId` 和 `signal` 转发给 `ctx.ui.ask`，让问题显示在对应会话中：

```ts
api.registerCommand({
  name: "notes", description: "Open saved notes",
  async run(_args, ctx) {
    if (!api.conversations) throw new Error("This host does not support saved extension conversations")
    const conversation = await api.conversations.openOrCreate({
      key: "notes", name: "Notes", cwd: api.cwd,
      systemPrompt: "Research and discuss notes. Ask the human before recording decisions.",
      callableTools: ["read", "grep", "glob", "ask_user"],
    }, {
      askUser: (questions, { sessionId, signal }) => ctx.ui.ask(questions, { sessionId, signal }),
    })
    if (!ctx.focusConversation?.(conversation)) ctx.print("Native conversation focus is unavailable")
  },
})
```

自定义视图仍可展示独立会话，而不替换主输入框。从 `api.session()` 读取主会话状态，从独立句柄读取此会话的记录和状态。不能省略独立会话问题的 `sessionId`，也不能在无法展示问题时推断用户选择。会话接口、`api.conversations` 和 `ToolSession.restricted` 自 API 0.1.51 起提供，原生聚焦自 API 0.1.52 起提供；仍应先检测能力是否可用，让旧宿主能正常降级。`writeRoots`、`descendants` 和 `runTool` 自 API 0.1.53 起提供。依赖这些策略前必须要求该宿主 API 版本：TypeScript 可选字段不等于能力检测，旧宿主在创建会话时可能忽略未知字段。

### 子 agent 控制

从 `@amira/api` 导入 `subagentTranscriptText(info, messages, all, now?)`，可将子 agent 的对话渲染为紧凑的纯文本。`/agents` 和 `/tasks` 在无法打开实时视图时使用它。即使收到通知或追问，它也会保留子 agent 原始任务的边界，包含工具调用、结果预览及完整的最终回复。格式化和消息筛选辅助函数属于内部实现；不要从其他扩展或内部包子路径导入它们。

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

设置 `activate` 的输入框不会自动接管键盘输入：按激活键后才进入输入框。占位文本包含激活提示；也可通过显式 `view.focus(id)` 或在 `needsTab: true` 时用 Tab 切换进入。Esc 先退出已激活的输入框，再弹出页面或关闭视图。省略 `activate` 时保留自动聚焦输入框的行为。

`UiContext` 在 `ViewRenderOptions` 基础上增加宿主持有的 `state: UiState` 和 height；height 为扣除等待提示、宿主按键栏及子页面标题后正文可用的行数，不会为负，并随终端尺寸变化更新。所有映射以稳定、整个视图内唯一的组件 ID 为键：`selected` 保存树或表格的选中项键，`expanded` 保存树中展开项的键数组，`activeTabs` 保存标签页键，`scroll` 保存 `{ top, following }`，`inputValues` 保存输入字符串；可选的 `focused` 保存焦点组件 ID。重绘、同类型视图的数据替换和非活动标签页均保留状态，直到视图关闭。选中项或标签页消失时选择第一个可见项或标签页；焦点无效时选择第一个无需输入激活的可见组件。请将上下文状态视为只读，并保持 `ui` 无副作用：宿主修复选中项、标签页或焦点后可能在同一帧重建内容，确保详情与控件一致；八次尝试后仍不稳定时安全地显示错误。没有 ID 的文本和表格可用滚轮滚动，但键盘焦点和显式状态管理需要稳定的 ID。

`onEvent(event, data, view)` 接收以 `type` 区分的事件：带 `{ id, key }` 的 select/activate、带 `{ id, key, expanded }` 的 toggle、带 `{ id, key }` 的 tab、带 `{ id, value }` 的 submit，以及已声明按键的 `{ key, focused? }`。在 `keys` 中声明快捷键（例如 `keys: [{ key: "x", label: "停止" }]`）；声明式视图通过 `onEvent` 接收它们，不调用旧的 `run` 回调。未声明的按键不产生事件。宿主先更新状态，再调用处理函数，因此 `view.setState(patch)` 可以覆盖默认结果。补丁为浅层替换：提供的顶层映射会替换整个映射，而不是合并其中条目；需要保留其他条目时使用 `{ ...ctx.state.selected, [id]: key }`。`view.focus(id)` 聚焦可见组件。原有 close、requestRender、print、prompt 和 confirm 方法仍可使用。提交输入不会自动清空内容。

设置 `needsTab: true` 时，Tab/Shift+Tab 在可见的树、带 ID 的表格及文本、标签栏和输入框之间移动焦点。没有可聚焦组件时，它们会通过 onEvent 交给已声明的 tab/shift-tab 快捷键；未声明的键不产生事件。未设置此选项时，Tab 将宿主焦点切换到主输入框。树用上下键选择，右键展开，左键折叠或选择父项，Enter 激活；表格用上下键选择，Enter 激活；标签栏用左右键切换；输入框用 Enter 提交。翻页键及 Home/End 滚动当前可滚动组件，滚轮作用于指针下的组件，不改变焦点或选中项。文本仅在 `follow: true` 或滚到末尾后跟随增长，向上滚动会停止跟随。组件按键优先于声明的快捷键，其余已声明按键交给 onEvent。Esc 先取消当前输入或确认提问，其次退出设置了 `activate` 的输入框，否则弹出页面或关闭根视图；Ctrl+C 始终关闭整个视图。q 关闭视图，但获得焦点的声明式输入框或 prompt 覆盖层会把它当作输入。prompt/confirm 覆盖层暂停组件输入，并独占光标。

输入、数据更新和 requestRender 会触发重绘，不增加组件动画计时器。树在每次准备布局时仅索引展开的行，只绘制视口内的行。纯语义组件仪表盘测试、180×52 和 80×24 快照位于 `packages/tui/test/ui-runtime`；运行 `bun packages/tui/test/ui-runtime/benchmark.ts` 可复现 180×50 下的 500 项嵌套树基准测试，覆盖 80 个组件卡片详情、时间线样式、展开及折叠状态，以及完整的 ExtensionViewer 路径。组件详情仅在所属项展开时测量，只绘制与视口相交的部分。

### 工具能力

请在 `traits` 中声明工具对 host 可见的能力，不要依赖工具名称；`readOnly: true` 允许工具在 plan 模式运行，`writesFiles: true` 表示工具会写文件，`writesFiles: "paths"` 还要求 `getWrittenPaths(params, { cwd })` 返回本次调用可能写入的全部路径，路径可以相对于 `cwd` 或使用绝对路径。
带有有效路径报告的写文件工具会参与和内置文件工具相同的受保护路径检查，但有一项有限的[扩展状态目录](#扩展状态目录)豁免；host 也会捕获写入前后的文件内容用于回退；报告缺失或无效时会采取保守策略并请求确认。
如果工具已经自行使用 `ctx.mutateFiles`，请设置 `usesMutationHook: true`，这样 host 不会再添加第二个回退边界。
运行命令的工具应设置 `shell: "bash"` 或 `shell: "powershell"`；如果实际 shell 在运行时才确定，也应保留 `shellKind()`。
编辑工具替代品应设置 `editor: "edit"` 或 `editor: "apply_patch"`，读取已保存输出的工具设置 `artifactReader: true`，延迟工具加载器设置 `toolSearch: true`，需要界面的工具设置 `interactive: true`。
`readKey(params, { cwd })` 可以为可重复的直接文件读取提供上下文去重标识。
未声明的能力仍视为未知：权限检查、回退和工作区刷新会继续采取保守行为；MCP 工具目前没有已知能力声明。

能力声明是受信任的：扩展以你自己的代码运行，因此对于工具自己的名字，声明 `readOnly` 或报告的路径少于实际写入的路径，都会被采信。但声明不能削弱内置名字的保护。注册在 `write`、`edit`、`apply_patch`、`bash`、`powershell`、`monitor` 或 `ask_user` 名下的工具（例如 `override`）无论声明什么，都保留该名字隐含的能力：`write`、`edit` 和 `apply_patch` 始终是写文件工具，除了它报告的路径，还会按参数中指明的路径做受保护路径检查；`bash`、`powershell` 和 `monitor` 始终是 shell 工具，受你的命令规则约束（除非 `shellKind()` 给出答案，bash 和 monitor 会按两种 shell 读法都检查）；它们在 plan 模式下都不算只读。既写文件又运行 shell 的工具会同时按两者检查。回退只捕获声明的写文件工具所报告的路径；`usesMutationHook: true` 告诉 host 该工具会通过 `ctx.mutateFiles` 自行捕获写入，声明了却没有这样做的工具不会被捕获。host 捕获声明的写文件工具时，整个调用期间都占用会话的文件捕获队列：其他文件写入（包括同一目录中的子 agent）都要等待它完成，因此这类工具应尽快结束，且不要等待其他 agent 的文件写入。

host 在 before 拦截器和审批之前固定 `shellKind()` 的结果，并通过 `ctx.shellKind` 交给执行器。`monitor` 还会以 `command` 和 `background: true` 参数经过所选 `bash` 或 `powershell` 名下的守卫；禁用 shell 工具也会阻止它。无法确定 shell 时，会同时检查两种 shell 的守卫和命令规则。monitor 自身的守卫仍然生效，shell 守卫禁止后台执行的决定不能被忽略。如果审批期间 monitor 所选的 shell 入口发生改变，调用会被拒绝并要求重试；分派执行前，还会按当前 host 策略重新检查已授权的入口。

`serverToolView(block)` 返回 provider 工具的名称、参数、结果文本和原生搜索详情（包括来源）；未完成的工具块还会带上 `rejected: "aborted"`。可以把其中的 `ToolCallView` 字段交给已有的工具展示器或其他前端使用；它只用于渲染，不能作为本地工具结果发回 provider。

命令可以调用 `ctx.openRewind()` 打开与连按两次 Esc 相同的回退选择器；只有具备该选择器的前端（终端 UI）才提供这个方法，选择器暂时无法打开时（例如轮次进行中）返回 false。

`SessionControl.rewind(index)` 默认恢复已捕获的文件修改。如果没有扩展接管文件恢复，而 core 的文件历史已禁用、不可用或已清理，调用会拒绝并说明原因，不会静默退化为仅回退对话。拒绝时对话保持不变。要仅回退对话，请显式传入 `{ restoreFiles: false }`。`planRewind(index)` 可预览恢复是否可用，并通过 `note` 说明原因。

扩展设置放在 `extensions` 中，以扩展名为键。设置快照被冻结，扩展应自行校验自己的字段；`api.settings.layers(key)` 按优先级顺序返回顶层键的显式值，每项带有 `scope`（`user`、`project`、`project-local` 或 `flags`）、`file` 和 `value`，没有该键时返回空数组。宿主重新加载设置时（包括 `/reload`）会提供新的快照和来源层，扩展可以据此协调长期资源，而无需自行读取设置文件。Print 模式会取消 UI 对话框，RPC 客户端通过协议回答。Panel、视图、工具展示器、Markdown 渲染器、图片 provider 和服务 API 目前属于实验功能。

`runCommand` 在命令退出后才返回。想边运行边拿到输出（比如显示一条耗时的 `git` 命令的进度），就传入 `onChunk`。通过 `signal` 中止（或等 `timeoutMs` 到期）会杀掉整个进程树，结果里的 `aborted` 或 `timedOut` 会说明原因。默认情况下，`output` 只保留最后 1,000,000 个字符；可以用正整数 `maxOutputChars` 覆盖该限制（无效值会导致调用被拒绝）。`onChunk` 仍会收到全部输出，`truncated` 会说明 `output` 是否被截断。截断不会拆开 UTF-16 代理对。

`complete({ messages, system?, model?, maxTokens?, signal?, label? })` 在对话之外发起一次模型请求，不带工具，关闭托管网页搜索，返回回复的文本、消息和用量。默认使用会话当前的模型（`model` 接受 `provider/model` 引用）。每次请求都会消耗你的 token：用量保存在会话中，在 `/cost` 里以 `label`（未设置时为扩展来源）列出，并计入 agent 树的 `budget`；预算用完后调用直接被拒绝，不会发出请求。推理模型至少获得 2,048 个输出 token（不超过其上限），以便思考后仍能作答。provider 错误会让 promise 被拒绝；`signal` 中止或扩展被卸载时，以 `AbortError` 拒绝。`session()` 在宿主建好会话控制后返回顶层会话的 `SessionControl`；`rename(title, { source: "auto", sessionId })` 不会覆盖 `/rename` 设置的名称，`sessionId` 已不是当前会话时什么也不做。

`api.complete` 计入当前主会话，不计入 owned conversation；`label` 不能覆盖归属。如需按 owner 记账，请使用上文绑定的 `OwnedConversation.complete`，固定模型并保持相同的纯文本语义。两条路径都会在拒绝前计入已报告的重试/错误/中止尝试；成功结果返回的 `usage` 本身不是完整账本。没有报告用量的请求保持未知，不能当作免费工作。

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

用量总计只涵盖已报告的用量，不保证覆盖全部计费工作。尤其是没有事件的旁路请求、没有模型事件的父模型咨询，以及未报告的失败请求用量，无法从追踪还原。需要子 agent 的详细时间或后代信息时，请单独读取它的追踪。追踪和 `budget.update` 载荷不是 owner 账本，也不保证覆盖发票。owned 账目应使用 `OwnedConversation.usage()`，或等待 `OwnedConversations.read(ref)` 并检查结果后读取其 `usage`，不要使用绑定主会话的 `sideRequests()` 或追踪合计。不要将追踪/runner/group 合计再次加到快照的 `total`；保留 `knownCostUsd`、覆盖不完整状态及按 revision 更新的有符号修正。

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

启动选项可提供 `onChange(change)`，从该任务的第一个事件开始观察，包括同步启动输出和最终状态快照。输出事件携带新增的原始 `output` 片段，不受保留缓冲区大小限制。需要按行处理时，请在观察器中保留分行状态，并当场捕获最终信息，不要等任务可能被移除后再查询。观察器抛出的异常不会破坏任务生命周期。

`readNew` 为每个 reader 名称维护独立游标，因此多个 reader 可以分别增量读取同一份输出。`waitFor` 可以等待正则表达式匹配、进程退出、超时或 abort signal。`subscribe` 只会报告本扩展任务的启动、状态、输出和结束变化；先用带宽限期的 `stop`，需要强制停止时再用 `0` 调用一次。

host 注册表向内置 host 代码提供 `maxRunning`、`configure`、`stopAll` 和 `isLimitError` 来处理限制。子 agent 的会话任务会在 `subagent.end` 事件交付后自动停止。顶层会话任务会跨越 `/clear`、`/resume` 和 `/fork` 继续运行：替换后的根会话可以列出、读取和停止它们，任务结束通知也会交付给新会话。直接通过 `ExtensionAPI.backgroundJobs` 启动的任务不会归属于调用会话，而会在启动它的扩展卸载（其 `subscribe` 监听也一并移除）或 Amira 退出时停止。卸载扩展（包括 `/reload`）不会停止会话中工具启动的任务。扩展应使用这个收窄后的 API，不要访问 `@amira/proc` 的全局注册表。

注册方法返回移除函数，host 会跟踪注册。卸载时自动移除；加载失败则回滚已注册内容。命令、工具、skill、状态项或 panel 重名时，有意替换需要 `override: true`，具体冲突规则以对应类型为准，避免意外替换其他扩展的内容。

事件包括 `session.start`（携带可选的初始 `title`）、`workspace.changed`、`tool.execute.start` 和 `tool.execute.end`（两者都带有工具的 `traits`，写文件工具还带有它报告的 `writtenPaths`）。监听器收到的事件封装包含数据和会话 ID，维护会话状态时应按会话筛选。重新加载后，新注册的监听器会收到当前会话、工作区、预算事件以及最新的 `ui.focus` 和 `ui.waiting` 状态。等待状态以 visibility 变化重放，不会再次宣布问题打开。自行创建的原生资源仍需自行清理。

`message.stream` 新增结构化计时事件，不改变可见的 `message.delta` 类型。`kind` 为 `request`（每次 provider 请求尝试发送前产生，可选 `thinkingDisplay: "summarized" | "omitted" | "raw"` 取自实际请求）、`contentStart`、`thinkingStart`、`thinkingEnd`（可选块 `index`），或 `end`（最后一个 provider 事件，可选上报的 `outputTokens`）。没有可读文字的块也会产生边界。使用封装中的 `ts`，而非监听器执行时间；重试的请求分别计时。可选的 `turn.start.sentAt` 在提示等待压缩时保留最初发送时间。RPC schema 也描述了这些新增字段；客户端应容忍新事件类型和缺失的可选字段。`Usage.outputReported: false` 区分仅搜索用量元数据与明确上报的零输出；输出量已上报时省略该字段。`compact.failed` 现在可携带 `usage` 与 `requested`；`compact.end` 和 `compact.failed` 可携带 `usageIncomplete`，表示部分请求未上报计数，避免把部分合计当成完整合计。

跨事件计时或维护状态时，使用可选的 `api.onEvents(types, handler)`。选定类型通过同一有序队列送达，并包含该订阅的 `events.lost`、重放匹配的当前状态事件；卸载时移除。单独的 `api.on` 订阅各有自己的队列，不能保证不同类型之间的顺序。没有 `onEvents` 的 host 无法提供有序计时收集器。

`api.terminal` 是稳定的结构化能力，提供 `setTitle(title: string)`、`setProgress(state: "none" | "indeterminate" | "paused")` 和 `bell()`，不暴露原始写入或转义序列。在 print 和 RPC 前端，这些方法不执行任何操作。TUI 清理标题中的控制字符，将其限制为 128 个终端单元格，在帧写入之外的微任务边界合并输出，遵守 `tui.title`、`tui.progress` 和 `tui.bell` 设置，检测进度支持，并在退出时恢复终端。

内置 `@amira/ext-terminal-status` 负责标题组合、工作与等待进度以及响铃策略；`--no-builtins` 会禁用它。问题（包括本地 rewind 对话框）、表单及覆盖视图变化后，TUI 发出 `ui.waiting`：`{ pending: number, hidden: boolean, change: "opened" | "resolved" | "visibility" }`。`hidden` 表示覆盖视图挡住了待回答的问题。隐藏问题打开时只响铃一次，可见性变化不再响铃。焦点通过 `ui.focus` 传递；完成回合或打开可见问题时，窗口失焦则响铃，焦点未知则在回合持续 15 秒后响铃。中断的回合不响铃。

修改入口文件后可用 `/reload`。入口导入的其他模块仍有缓存，因此修改辅助模块后需要重启 Amira。渲染回调应保持轻量，改变可见状态后调用 `requestRender`。

相关文档：[快速开始](getting-started.md)、[子 agent](subagents.md)、[使用与会话](usage.md)、[设置](settings.md)、[快捷键](keybindings.md)。
