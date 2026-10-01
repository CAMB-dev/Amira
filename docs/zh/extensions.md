[English](../extensions.md) · [文档首页](../../README.zh-CN.md)

# 使用与编写扩展

扩展可以添加工具、命令和界面行为。安装的包可以包含多个扩展、skill 和顶层 CLI 命令。扩展会以你的权限在本机运行代码。

## 查找与管理扩展包

```sh
amira ext search
amira ext search workflow
amira ext list
amira ext help
```

搜索默认使用 [CAMB-dev/amira-extensions](https://github.com/CAMB-dev/amira-extensions) 的官方索引。缓存通常使用一小时，`--refresh` 强制重新获取。`AMIRA_EXTENSIONS_INDEX` 可指向其他索引 URL 或本地索引文件。索引提供包名和来源，搜索不会安装包。

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

安装、更新、删除、启用或禁用后，重启 Amira，或在空闲时运行 `/reload`。`/help` 会列出已加载扩展注册的命令。当前版本通过上述 shell CLI 管理扩展包。

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
| `ui` | 通过选择、确认、输入、表单和审阅对话框询问用户，命令上下文也提供 UI 请求 |
| `registerPanel` | 在活动行上方渲染实时内容 |
| `registerView` | 注册全屏视图类型，命令在前端支持时通过 `openView` 打开 |
| `registerToolRenderer`、`decorateToolRenderer` | 展示工具调用和结果，或包装已有展示器 |
| `registerMarkdownRenderer`、`registerImageProvider` | 渲染回复中匹配的代码块或独立图片，并提供终端图片数据 |
| `provideService`、`useService` | 共享具名服务；使用时再查找，提供方可能未加载或已卸载 |
| `settings`、`cwd`、`home`、`apiVersion` | 读取合并后的设置、工作目录、用户目录和 API 版本 |
| `runCommand`、`openPipe`、`onExit` | 运行受管理的子进程、启动长期管道进程，或注册短时退出工作 |
| `notify`、`reportError` | 显示提示或报告后台错误 |

扩展设置放在 `extensions` 中，以扩展名为键。设置快照被冻结，扩展应自行校验自己的字段。Print 模式会取消 UI 对话框，RPC 客户端通过协议回答。Panel、视图、工具展示器、Markdown 渲染器、图片 provider 和服务 API 目前属于实验功能。

注册方法返回移除函数，host 会跟踪注册。卸载时自动移除；加载失败则回滚已注册内容。命令、工具、skill、状态项或 panel 重名时，有意替换需要 `override: true`，具体冲突规则以对应类型为准，避免意外替换其他扩展的内容。

事件包括 `session.start`、`workspace.changed`、`tool.execute.start` 和 `tool.execute.end`。监听器收到的事件封装包含数据和会话 ID，维护会话状态时应按会话筛选。重新加载后，新注册的监听器会收到当前会话、工作区和预算事件，以便恢复状态。自行创建的原生资源仍需自行清理。

修改入口文件后可用 `/reload`。入口导入的其他模块仍有缓存，因此修改辅助模块后需要重启 Amira。渲染回调应保持轻量，改变可见状态后调用 `requestRender`。

相关文档：[开始使用](getting-started.md)、[子 agent](subagents.md)、[使用与会话](usage.md)、[设置](settings.md)、[快捷键](keybindings.md)。
