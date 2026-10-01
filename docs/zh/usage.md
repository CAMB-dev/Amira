# 使用 Amira

[English](../usage.md) · [文档首页](../../README.zh-CN.md)

在要处理的项目目录运行 `amira`。命令行末尾的提示词会成为第一条消息，也可以用 `--cwd` 指定工作目录。provider 配置见[快速开始](getting-started.md)。

## 终端模式与对话记录

```sh
amira --fullscreen
amira --inline
amira --cwd /path/to/project "Explain this repository"
```

默认使用全屏模式：Amira 在终端备用屏幕中管理对话记录，负责滚动和搜索；退出时把当前显示的会话输出到普通终端。内联模式把已完成的消息和工具调用留在终端滚动缓冲区，使用终端自己的滚动、搜索和选中文字功能，适合 SSH 或 tmux。命令行标志优先于[设置](settings.md)中的 `tui.mode`。

对话记录包含用户消息、流式回复、模型提供的思考内容、工具执行情况、问题和提示。全屏模式中，PgUp/PgDn 滚动记录；输入为空时，End 回到最新输出。Ctrl+F 搜索记录；Ctrl+Up 选中一个内容块，↑/↓ 切换内容块，Enter 折叠或展开，`y` 复制。部分终端需要[快捷键](keybindings.md)中列出的替代绑定。

两种模式都可以用 Ctrl+O 切换工具输出详细程度，也可以在交互界面用 `/verbose` 控制。Alt+C 将最后一条回复作为 Markdown 复制。全屏模式中拖动鼠标选中文字，松开后自动复制；Shift+拖动使用终端自己的选区。输入为空时按 `?` 查看当前快捷键。

## 发送、引导与排队

空闲时按 Enter 发送消息。轮次运行期间，Enter 默认发送**引导**消息：它会在下一次模型请求前进入当前轮次，但不会打断正在执行的工具。Alt+Enter 将消息**排队**，等当前轮次结束后发送。Windows Terminal 可能占用 Alt+Enter，此时可以用 Ctrl+Q。将 `tui.submitWhileWorking` 设为 `"queue"` 会交换这两个操作。

终端支持时，Shift+Enter 插入换行；Ctrl+Enter 是备用绑定。输入 `/` 补全命令，输入 `$` 补全 skill，输入 `@` 和部分路径补全文件。编辑、补全和历史记录操作见[快捷键](keybindings.md)。

Esc 停止当前轮次；如果 `/ext install` 等斜杠命令仍在运行，会先取消该命令并保留输入框中的草稿。如果有等待中的引导或排队消息，它们会按输入顺序合并为一条消息并一起发送。后台子 agent 会继续工作，停止方法见[子 agent](subagents.md)。Ctrl+C 同样先取消正在运行的命令，其次停止轮次，空闲时先清空非空输入，输入为空则退出；也可以用 `/quit` 退出。

## 工具与审批

内置工具可以读取、搜索、写入和编辑文件，运行 shell 命令，搜索网页并分派任务。具体可用工具取决于平台、模型和加载的扩展。`/tools` 列出当前工具；`/tools disable <name>` 和 `/tools enable <name>` 修改本次会话的工具可用性。启动时可用 `--disable-tools` 传入逗号分隔的工具名。持久配置见[设置](settings.md)与[扩展](extensions.md)。

修改文件有两种编辑工具。`edit` 在单个文件中替换一段确切的文本。`apply_patch` 接收 Codex 格式的补丁（`*** Begin Patch` … `*** End Patch`），一次可以新增、删除、修改和移动多个文件；它在写入前校验所有 hunk，写入中途失败时回滚已写入的部分。除非 provider 设置另有选择，每个模型默认使用 `edit`，详见[编辑工具](providers.md#编辑工具)。`write` 始终可用。当前模型不使用的那个编辑工具会在 `/tools` 中显示为禁用并附上原因，`/tools enable` 也无法启用它，需要修改设置。

审批请求来自[权限策略](#权限)和扩展；扩展可以拦截工具调用，拒绝执行或要求用户批准。审批界面显示工具名、原因（包括引起询问的模式或规则），以及预览或参数。用方向键选项，再按 Enter；确认框初始没有选中项。Esc 拒绝该调用并停止轮次。

如果界面提供 `Don't ask again`，它只允许**该工具因同一原因**提出的调用，在当前会话剩余时间内生效，不会保存持久权限。子 agent 的权限询问直接交给你，而不是交给父 agent；扩展为子 agent 提出的审批仍由父 agent 的模型决定。打印模式无法回答对话框，因此需要审批的调用会被拒绝，问题会被取消；RPC 客户端必须显式回答界面请求，客户端关闭 stdin 后，审批一律拒绝。

## 权限

权限模式决定模型无需询问就能做什么，对整个会话（包括子 agent）生效。

| 模式 | 作用 |
| --- | --- |
| `auto`（默认） | 所有操作都不询问，除非你的规则或受保护文件另有要求 |
| `edits` | 修改文件不询问；`allow` 规则未覆盖的 shell 命令运行前询问 |
| `plan` | 只读：不修改文件，不运行 shell 命令；对无法确认只读的工具（例如 MCP 工具）先询问 |

在界面中按 Shift+Tab 依次切换 `auto`、`edits` 和 `plan`；非 `auto` 模式会显示在输入框边框中的模型名旁边。启动时可用 `--permission-mode <mode>` 或设置中的 `"permissions": {"mode": "edits"}` 选择模式。目前 plan 模式会拦截所有 shell 命令，因为 Amira 还无法证明一条命令只读不写。

命令规则按命令的词允许、询问或拒绝 shell 命令：

```json
{
  "permissions": {
    "mode": "edits",
    "rules": [
      { "command": ["git", "status"], "decision": "allow" },
      { "command": ["git", "push"], "decision": "ask", "reason": "Review what goes out" },
      { "command": ["rm", "-rf"], "decision": "deny" }
    ]
  }
}
```

规则匹配的是命令的词（argv），而不是文本：`git status --short` 匹配 `["git", "status"]`，`git statusx` 不匹配。命令名写成路径或带 Windows 扩展名（`/usr/bin/git`、`git.exe`）时同样匹配。`ask` 和 `deny` 规则在中间夹有其他词时也匹配（`git -C repo push` 匹配 `["git", "push"]`），并且不区分大小写；`allow` 规则必须与命令开头逐词一致。多条规则同时匹配时，`deny` 优先于 `ask`，`ask` 优先于 `allow`。`allow` 只表示“不询问”，不会解除 plan 模式，也不会放开受保护文件。

用 `&&`、`||`、`;`、`|` 或换行连接的命令会被拆开，逐个检查。Amira 无法逐词检查的命令一律改为询问：`$(...)` 和反引号等替换、变量、重定向到文件、here-document 和 here-string、分组、会运行其他命令的包装命令（`eval`、`sudo`、`bash -c`、`Invoke-Expression`、`Start-Process`、各类解释器）以及脚本。在 `auto` 模式下，只要没有 `ask` 或 `deny` 规则，这类命令仍然直接运行。命令按实际运行它的 shell 解析：bash 或 PowerShell，包括 `bash` 工具在 Windows 上退回 PowerShell 的情况。

用户设置文件中的规则始终生效。项目的 `.amira/settings.json` 或 `.amira/settings.local.json` 只能收紧权限：比你的模式更严格时，项目的模式才生效；项目的 `ask` 和 `deny` 规则直接生效；项目的 `allow` 规则要在你信任该项目后才生效（`amira ext trust`，与项目扩展包所需的信任相同）。项目文件不允许修改的内容会在启动时提示。`--permission-mode` 优先于所有设置文件。`/permissions` 列出当前模式、每条规则及其来源文件，以及被忽略的设置；`/status` 显示模式和规则数量。

有些文件无论处于哪种模式，`write`、`edit` 或 `apply_patch` 修改前都会询问：`.amira` 目录（设置、扩展包和锁文件）和 Amira 用户目录、`.git`（hooks、config 以及其他 Git 元数据，包括链接 worktree 的 Git 目录）、`.gitmodules`、`core.hooksPath` 指向的目录，以及你的全局 Git 配置。同一文件的其他写法也算在内（大小写不同、`../`、绝对路径、MSYS 路径、链接）。**shell 命令目前仍然可以修改这些文件，因为命令还没有在沙箱中运行。**

被拒绝的调用会告诉模型原因，并提示它应当询问你。在打印模式下，以及 RPC 中没有客户端能回答时，所有需要询问的操作都会被拒绝并说明原因；无人值守运行请使用 `auto` 模式或规则。

## 会话、压缩与回退

对话自动保存，按工作目录列出。退出非空会话时，Amira 会显示继续该会话的命令。

| 操作 | 命令 |
| --- | --- |
| 继续此目录最新的会话 | `amira -c` 或 `amira --continue` |
| 选择已有会话 | `amira -r` 或 `amira --resume` |
| 恢复指定会话 | `amira -r <session-id>` |
| 不打开界面，列出会话 | `amira -p -r` |
| 在界面中选择或切换会话 | `/resume` 或 `/resume <session-id>` |
| 开始空白对话 | `/clear` |
| 立即压缩较早的上下文 | `/compact` 或 `/compact <instructions>` |

`-c` 与 `-r` 不能同时使用。会话 ID 以 `s_` 开头，请使用列表中的实际 ID。`/clear` 创建新会话，原会话仍可恢复。`/resume` 保留当前选中的模型；如果尚未选择模型，可以使用会话原来的模型。切换会话会停止旧对话的后台任务。

自动压缩默认在达到模型上下文窗口的 80% 时触发，缩减较早的内容并保留近期对话。兼容的 provider 可以使用原生压缩，否则 Amira 生成文字摘要。给 `/compact` 提供额外指令时会强制使用文字摘要。条件和配置见[Provider](providers.md)与[设置](settings.md)；`/context` 可以查看上下文窗口的内容分布。

连续按两次 Esc 打开回退选择器。选中较早的用户消息后，该消息及其后续内容会从当前对话中移除，选中的提示词回到编辑器，可修改后重新发送。**回退不会恢复文件，也不会撤销 shell 命令。** 只能回退到压缩后仍保留的消息，而且会话必须已保存。补全列表、选区或对话框可能先处理 Esc，请以当前提示栏为准。

## 打印模式

```sh
amira -p "Summarize the changes in this repository"
amira -p -c "Continue the review"
amira -p --json "Explain the failing test"
amira -p -- "-v means verbose?"
```

`-p` / `--print` 不打开交互界面。除用不带 ID 的 `-r` 列出会话外，必须提供提示词。普通模式把回复文本流式写入 stdout，把工具执行情况、警告和错误写入 stderr。`--json` 必须与打印模式一起使用，将每个事件作为一行 JSON 写入 stdout，包含会话、轮次、消息、工具与子 agent 事件，并非只输出一个最终 JSON 答案。

带引号的命令，例如 `amira -p "/status"`，直接执行命令，不发送模型提示词；已加载的 skill 也可以这样运行。需要选择器的命令无法获得交互回答，支持显式参数时请直接传入参数。

打印模式会等待后台子 agent，以及结果触发的后续轮次。等待没有固定时限，配置的预算仍然生效。结果投递轮次失败后最多重试三次，分别等待 10、30 和 90 秒。Ctrl+C 中止并停止等待，再按一次强制退出。退出码为：完成时 0，错误时 1，轮次被中止时 130。

## RPC 自动化

```sh
amira --rpc
amira --rpc-schema
```

RPC 在 stdin 和 stdout 使用 JSON Lines，不能与 `-p` 或命令行提示词一起使用。`--rpc-schema` 打印完整协议 schema 后退出，不启动模型轮次。启动时恢复会话可用 `--resume <session-id>` 或 `-c`；RPC 模式不支持不带 ID 的 `-r`。

每行发送一个对象，将 `id`、`cmd` 和命令参数都放在顶层。例如，在已配置模型的连接中发送：

```json
{"id":1,"cmd":"prompt","text":"Explain the test layout"}
```

立即返回的响应包含请求 ID、`ok: true` 和 `turnId`，表示轮次已启动，不代表完成。事件与响应会交错输出；等待相应的 `turn.end` 判断结果。命令失败时返回 `ok: false`，错误对象包含 `code` 与 `message`。

| 命令 | 用途 |
| --- | --- |
| `prompt` | 启动轮次；已有任务时返回 `busy` |
| `steer` | 在下一次模型调用前加入指令；空闲时启动轮次 |
| `abort` | 停止轮次或压缩 |
| `state` | 获取状态、模型、会话和待回答的界面请求 |
| `session.read` | 用 `what` 参数选择 `messages` 或 `lastTurn` |
| `session.resume` | 用 `sessionId` 切换到已有会话 |
| `model.set` | 用 `model` 指定 provider/model，切换模型 |
| `command.list`、`command.complete`、`command.run` | 查询、补全和执行斜杠命令 |
| `skill.list`、`skill.run` | 查询和运行 skill |
| `ui.respond` | 用 `requestId` 与 `value` 回答界面请求 |
| `ui.action`、`ui.configure`、`ui.focus` | 处理表单操作、表单呈现方式与客户端焦点 |

参数和界面回答格式以生成的 schema 为准。例如确认框使用布尔 `value`；显式 `null` 取消对话框，省略 `value` 则无效。请求等待回答时，客户端仍可发送后续输入行。如果慢速客户端收到 `events.lost`，用 `state` 与 `session.read` 重新同步。工作期间持续读取 stdout。

关闭 stdin 后，Amira 会等待正在进行的工作，包括后台结果及其触发的后续轮次；无人能回答的对话框会取消。需要对话框的命令应在结束前保持 stdin 打开。

## 状态与费用

`/status` 显示模型、provider、会话 ID 与文件、上下文用量和窗口、输出 token、缓存命中率、最近回复速度、已知费用、shell、权限模式与规则数量，以及 Git 工作区。恢复的会话会包含之前运行的用量。状态栏显示本次运行以来的 agent 树用量；`/status` 可以包含已保存会话及其子 agent 的费用。

`/cost` 按模型列出当前会话回复的费用，并单独列出压缩用量，不合计子 agent 费用；子 agent 信息见 `/status` 与 `/agents`。费用依赖已知模型定价和上报用量：未知价格会明确标出，含未知价格行的合计只是部分估算。实际收费以 provider 账单为准。

相关文档：[快速开始](getting-started.md) · [Provider](providers.md) · [子 agent](subagents.md) · [扩展](extensions.md) · [设置](settings.md) · [快捷键](keybindings.md)。
