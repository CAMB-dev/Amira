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
| `registerMarkdownRenderer`、`registerImageProvider` | 渲染回复中匹配的代码块或独立图片，并提供终端图片数据 |
| `provideService`、`useService` | 共享具名服务；使用时再查找，提供方可能未加载或已卸载 |
| `settings`、`cwd`、`home`、`apiVersion` | 读取合并后的设置、每个顶层键的来源层、工作目录、用户目录和 API 版本 |
| `backgroundJobs` | 启动并查看本扩展自己启动的后台任务；内置前端代码使用仅供 host 使用的 `hostBackgroundJobs()` 能力 |
| `runCommand`、`openPipe`、`onExit` | 运行受管理的子进程、启动长期管道进程，或注册短时退出工作 |
| `notify`、`reportError` | 显示提示或报告后台错误 |
| `registerFileRestoration` | 接管回退时的文件恢复（例如 checkpoints 扩展）：选择器显示你提供的选项，core 不再恢复文件；同一时间只能有一个扩展接管，卸载时释放 |

### 全屏视图

通过 `api.registerView()` 注册 `ViewDefinition`，命令用
`ctx.openView?.({ kind, data })` 打开它。视图返回纯文本的 `ViewLine` 对象；前端负责
终端、换行、滚动、输入提示和确认。`subagent` 类型和 `/agents` 命令由内置 agent
扩展注册。没有加载该扩展时，从对话中的子 agent 块打开视图会提示实时视图不可用。

`title(data, opts)` 给出第一行；`titleAside(data)` 在其右端追加一段简短文字，如
`2 of 5`，屏幕较窄时先截断标题，这段文字保持完整。

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

### 工具能力

请在 `traits` 中声明工具对 host 可见的能力，不要依赖工具名称；`readOnly: true` 允许工具在 plan 模式运行，`writesFiles: true` 表示工具会写文件，`writesFiles: "paths"` 还要求 `getWrittenPaths(params, { cwd })` 返回本次调用可能写入的全部路径，路径可以相对于 `cwd` 或使用绝对路径。
带有有效路径报告的写文件工具会参与和内置文件工具相同的受保护路径检查，host 也会捕获写入前后的文件内容用于回退；报告缺失或无效时会采取保守策略并请求确认。
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
`@amira/core` 中已弃用的 `gitInfo` 和 `trackWorkspace` 委托给已注册的 provider：没有针对该 `cwd`
注册的 provider 时，`gitInfo` 返回空信息；`trackWorkspace` 需要其总线上已有 provider。它们不再独立启动 Git。

### 后台任务

`ExtensionAPI.backgroundJobs` 是扩展级视图：它只能启动任务，并列出、读取、等待、停止和订阅本扩展自己启动的任务；它不能配置 host 注册表、停止全部任务、关闭会话或在根会话之间转移任务。`/jobs` 命令和 TUI 面板等内置前端代码使用仅供 host 使用的 `hostBackgroundJobs()` 能力，因此仍能看到工具启动的会话任务；工具执行器应使用会话级的 `ctx.backgroundJobs`，因为这个公共边界会携带任务所有权和可见性。

启动任务时提供 `command`、`argv`、`cwd`、`env` 和 `shell`。会话 host 会自动记录子 agent 的所有者；主会话可以看到自己的任务和所有子 agent 的任务，子 agent 只能看到自己的任务。`list`、`get`、`running`、`output`、`tail` 和 `stop` 都会执行可见性检查，不可访问的任务会按不存在处理。

`readNew` 为每个 reader 名称维护独立游标，因此多个 reader 可以分别增量读取同一份输出。`waitFor` 可以等待正则表达式匹配、进程退出、超时或 abort signal。`subscribe` 只会报告本扩展任务的启动、状态、输出和结束变化；先用带宽限期的 `stop`，需要强制停止时再用 `0` 调用一次。

host 注册表向内置 host 代码提供 `maxRunning`、`configure`、`stopAll` 和 `isLimitError` 来处理限制。子 agent 的会话任务会在 `subagent.end` 事件交付后自动停止。顶层会话任务会跨越 `/clear`、`/resume` 和 `/fork` 继续运行：替换后的根会话可以列出、读取和停止它们，任务结束通知也会交付给新会话。直接通过 `ExtensionAPI.backgroundJobs` 启动的任务不会归属于调用会话，而会在启动它的扩展卸载（其 `subscribe` 监听也一并移除）或 Amira 退出时停止。卸载扩展（包括 `/reload`）不会停止会话中工具启动的任务。扩展应使用这个收窄后的 API，不要访问 `@amira/proc` 的全局注册表。

注册方法返回移除函数，host 会跟踪注册。卸载时自动移除；加载失败则回滚已注册内容。命令、工具、skill、状态项或 panel 重名时，有意替换需要 `override: true`，具体冲突规则以对应类型为准，避免意外替换其他扩展的内容。

事件包括 `session.start`、`workspace.changed`、`tool.execute.start` 和 `tool.execute.end`（两者都带有工具的 `traits`，写文件工具还带有它报告的 `writtenPaths`）。监听器收到的事件封装包含数据和会话 ID，维护会话状态时应按会话筛选。重新加载后，新注册的监听器会收到当前会话、工作区和预算事件，以便恢复状态。自行创建的原生资源仍需自行清理。

修改入口文件后可用 `/reload`。入口导入的其他模块仍有缓存，因此修改辅助模块后需要重启 Amira。渲染回调应保持轻量，改变可见状态后调用 `requestRender`。

相关文档：[快速开始](getting-started.md)、[子 agent](subagents.md)、[使用与会话](usage.md)、[设置](settings.md)、[快捷键](keybindings.md)。
