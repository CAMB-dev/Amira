# 快捷键

[English](../keybindings.md) · [日本語](../ja/keybindings.md) · [文档首页](../../README.zh-CN.md)

交互界面的快捷键都对应一个 action。要修改绑定，在 `~/.amira/keybindings.json`（或 `$AMIRA_HOME/keybindings.json`）中写入 JSON 对象，将 action 名称映射为一个按键或按键列表：

```json
{
  "queue": "ctrl+b",
  "newline": ["shift+enter", "ctrl+j"],
  "redraw": []
}
```

一个按键或列表会替换该 action 的全部默认绑定，空列表则取消绑定。输入框下方显示列表中的第一个按键；`newline` 会选用终端能报告的第一个。文件在启动时读取。未知 action、无法识别的按键，以及同一场景中重复绑定的按键会产生警告，其余有效配置仍然生效。JSON 格式错误时使用默认绑定。

提示行只显示当前适用的快捷键：空闲时是 `Enter send · ? keys`，有文本时会显示换行键；轮次运行时显示引导、排队和中断键，有等待消息时显示 `Esc send queued`。列表、搜索和选中状态有各自的提示。输入框为空且没有对话框或列表时，`?` 打开完整按键参考，显示当前绑定和配置所用的 action 名称；↑↓、PgUp/PgDn、Home/End 滚动，Esc、`q` 或 `?` 关闭。

## 按键写法

修饰键和主键用 `+` 连接，不区分大小写，例如 `ctrl+q`、`alt+enter`、`shift+tab`、`escape`、`y`。

- 修饰键：`ctrl`、`alt`（也接受 `option`、`meta`）、`shift`。
- 主键：`enter`、`tab`、`escape`（或 `esc`）、`backspace`、`delete`、`insert`、`space`、`up`、`down`、`left`、`right`、`home`、`end`、`pageup`、`pagedown`、`f1` 到 `f12`，或单个字符。`ctrl++` 表示 Ctrl 加加号。
- 普通字符不区分 Shift，`y` 也匹配 `Y`；命名按键和快捷键精确匹配 Shift，所以 `enter` 不匹配 `shift+enter`。

能否收到按键取决于终端。Shift+Enter 需要支持相应按键报告的终端，例如 Windows Terminal、VS Code 或支持 kitty keyboard protocol 的终端；其他终端可以用 Ctrl+Enter 换行。终端或编辑器也可能截获按键：Windows Terminal 使用 Alt+Enter 切换全屏；VS Code 通常截获 Ctrl+Q，除非从 `terminal.integrated.commandsToSkipShell` 中移除对应命令。以 Amira 的提示行和 `?` 为准。

## 输入

| Action | 默认按键 | 行为 |
| --- | --- | --- |
| `submit` | `enter` | 发送消息；轮次运行时发送引导消息，设置 `tui.submitWhileWorking: "queue"` 后改为排队 |
| `newline` | `shift+enter`、`ctrl+enter` | 换行 |
| `paste.image` | `alt+v`、`ctrl+v`、`shift+insert` | 剪贴板有文本时粘贴文本，否则附加剪贴板中的图片（见[图片](usage.md#图片)）。Windows Terminal、VS Code 等终端自己占用 Ctrl+V 或 Shift+Insert 作为粘贴键；Alt+V 可以传到 Amira（macOS 上需把 Option 设为 Meta 键） |
| `queue` | `alt+enter`、`ctrl+q`（Windows；VS Code 中 `ctrl+q` 优先） | 轮次运行时把消息排队；设置 `tui.submitWhileWorking: "queue"` 后改为引导 |
| `submit.steer` | 无 | 发送消息；运行期间始终用于引导 |
| `submit.queue` | 无 | 发送消息；运行期间始终用于排队 |
| `interrupt` | `escape` | 有命令正在运行时先取消命令并保留输入；否则中断轮次。有等待中的引导或排队消息时，按原输入顺序合并并立即发送。连续按两次（空闲时也可以）打开回退选择器，按时间倒序列出用户消息；选中消息及其后续对话会被移除，选中消息回到输入框供修改。按 `f` 则从该消息之前分支到新会话，当前会话保持完整。不会恢复文件 |
| `cancel` | `ctrl+c` | 有命令正在运行时先取消命令并保留输入；否则在运行时中断轮次；等待消息的处理与 `interrupt` 相同。空闲时先清空输入，输入已空则退出 |
| `exit` | `ctrl+d` | 输入为空且没有轮次运行时退出 |
| `redraw` | `ctrl+l` | 清屏并重新绘制最新对话记录和输入框 |
| `history.prev` | `up` | 光标在输入首行时调出上一条提示词 |
| `history.next` | `down` | 光标在输入末行时调出下一条提示词 |
| `history.search` | `ctrl+r` | 搜索提示词历史 |
| `tool-output` | `ctrl+o` | 在摘要和完整工具输出之间切换；折叠级别返回摘要 |
| `panels.toggle` | `ctrl+t` | 把活动行上方的实时面板折叠为一行，或展开 |
| `permissions.mode` | `shift+tab` | 依次切换[权限模式](usage.md#权限)：`auto`、`edits`（修改文件不询问，运行 shell 命令前询问）、`plan`（只读）。提示栏会说明新模式的作用；非 `auto` 模式显示在输入框边框中的模型名旁边。对整个会话生效，包括子 agent |
| `copy.reply` | `alt+c` | 将会话最后一条回复按 Markdown 复制到剪贴板，两种界面模式都可用 |
| `help` | `?` | 输入为空且没有对话框或列表时打开按键参考；输入有文本时作为普通字符输入 |
| `edit.kill-to-start` | `ctrl+u` | 剪切行首到光标的文本；在行首则剪切前一个换行 |
| `edit.kill-to-end` | `ctrl+k` | 剪切光标到行尾的文本；在行尾则剪切后一个换行 |
| `edit.kill-word` | `ctrl+w` | 剪切光标前的单词 |
| `edit.yank` | `ctrl+y` | 粘贴最后剪切的文本；连续剪切会合并，折叠的粘贴内容仍保持折叠 |
| `edit.undo` | `ctrl+z` | 撤销最近一次输入操作，包括输入、连续删除、剪切、粘贴或历史调取 |
| `edit.redo` | `ctrl+shift+z` | 重做。没有 kitty keyboard protocol 的终端可能把它报告为 Ctrl+Z，需要另行绑定 |
| `edit.external` | `ctrl+g` | 依次使用 `$VISUAL`、`$EDITOR`、Git 的 `core.editor` 指定的命令编辑消息（如 `code --wait`）；均未指定则 Windows 使用 Notepad，其他系统使用 vi。编辑器退出后，保存的文本回到输入框 |

[扩展拥有的持久会话](extensions.md#扩展拥有的持久会话)获得原生焦点时，F6（`view.focus`，或自定义绑定）返回主会话，不停止任何会话。已聚焦会话空闲且输入框为空时，Esc（`interrupt`）也返回；工作期间，Esc/Ctrl+C（`interrupt`/`cancel`）只停止此会话，不停止后台主会话。对话框、补全列表和历史搜索保留按键优先级。草稿、提示词历史、图片和粘贴内容按会话隔离；`@` 文件补全使用此会话的工作目录。斜杠命令和 skill 只显示提示，不执行：先返回主会话，再显式执行。

## 补全列表

输入开头是 `/` 或 `$` 时显示命令或 skill 列表；输入 `@word` 时显示文件列表。列表先于输入框处理快捷键。单独输入 `/` 或 `$` 时不预选任何条目，Enter 不执行，按一次 ↓ 选中第一项。skill 必须已明确选中，或名称匹配输入前缀，Enter 才会运行；`$100 is the price` 一类文本仍作为普通消息发送。名称没有匹配项时列表保持打开，如 `no command matches /zzz`；单独输入 `$zzz` 时，要用 Esc 关闭列表才能发送文本。

| Action | 默认按键 | 行为 |
| --- | --- | --- |
| `popup.up` | `up` | 选择上一条命令、skill、参数或文件 |
| `popup.down` | `down` | 选择下一条 |
| `popup.complete` | `tab` | 补全命令、skill 或参数；插入文件路径 |
| `popup.accept` | `enter` | 执行命令或 skill；插入文件路径 |
| `popup.close` | `escape` | 关闭列表，文本改变后可再次出现 |

## 历史搜索

搜索期间输入文本会缩小匹配范围；方向键等其他按键会保留匹配文本、退出搜索，再执行其原有操作。

| Action | 默认按键 | 行为 |
| --- | --- | --- |
| `search.older` | `ctrl+r` | 下一个更早的匹配 |
| `search.newer` | `ctrl+s` | 下一个更晚的匹配 |
| `search.accept` | `enter` | 将匹配保留在输入框中供修改或发送 |
| `search.cancel` | `escape`、`ctrl+c`、`ctrl+g` | 退出并恢复原草稿 |

## 对话框

授权、确认、列表、diff 审查、文本输入和模型通过 `ask_user` 发出的提问都以对话块显示，左侧有竖线，下方显示选项和按键。最多九个选项的非确认列表可以按选项前的数字选择；多选列表中数字切换勾选。`Other…` 在原位置打开文本框，Enter 保留文本，Esc 关闭输入，再按 Esc 取消对话框。多个问题在同一块中依次作答并一起提交：Enter 进入下一题，在后续题按 Esc 返回上一题并保留已有答案。

分区列表可能为不同分区提供额外按键，以提示行为准。`/agents` 中选中子 agent 后按 Enter 打开实时查看器，按 `p` 将其对话记录打印到主对话中；选中保留的 worktree 后按 Enter 查看 diff，再决定合并、保留或丢弃。

在 `/ext` 中，Enter 管理选中的已安装扩展，或从索引安装选中的扩展；`d` 显示选中扩展的详情。直接输入可以过滤列表，过滤框有文字后 `d` 也会作为过滤文字。安装和更新期间输入框仍可使用，并显示实时进度面板。不在对话框或补全列表中时，Esc（`interrupt`）或 Ctrl+C（`cancel`）取消正在运行的命令并保留草稿，已完成的改动保持安装状态。提示行使用当前的快捷键绑定。包的改动在空闲时运行 `/reload` 后生效。

已加载且声明设置的扩展还提供 **Settings** 操作；独立文件列在 **Standalone** 分组中，只提供 Settings 和 Show details。`/ext config <name>` 可直接打开设置页面，使用 `/ext` 中显示的宿主生成文件名（例如 `my-extension`；与文件或包重名时追加 `-2`、`-3`）。也可以使用带引号的绝对路径：`/ext config "/path/to/my extension.ts"`、`/ext config "C:\\extensions\\my extension.ts"`。这些命令名称不会改变独立文件设置使用的绝对路径存储身份。实时预览不会改变保存值。上下键选择行，左右键或 `-` / `+` 调整数字，输入数字在范围内设置值，左右键循环选项，空格切换 on/off。文本和颜色使用单行输入。`ctrl+r` 将当前行重置为默认值。Enter 在页面内询问保存到用户还是项目设置，再次 Enter 保存并立即通知扩展。Esc 丢弃草稿。焦点行下方的说明会自动换行，不同于默认值的设置带有标记。

在 `/provider` 中，首行 **+ Add provider** 开始添加；选中 provider 后按 Enter 可编辑、设置密钥、测试连接或删除。Esc 关闭页面。全屏表单的多选字段支持直接输入过滤 ID 和标签，Backspace 编辑过滤内容，空格切换勾选，Ctrl+A 全选匹配过滤条件的选项或清空，Ctrl+X 反选这些选项，包括屏幕外的匹配行。过滤范围外的选择保留。Esc 先清除非空过滤内容，再取消表单。这些字段内按键不改变文本编辑器的绑定，Ctrl+S 仍用于保存。

在 `/resume` 中直接输入会搜索标题和对话内容，匹配的文字显示在每行下方；Ctrl+D 在确认后删除选中的会话。

确认对话框默认不选中任何选项，先用方向键选择，Enter 才会确认，避免原本在消息中输入的按键误答授权。默认没有直接确认的单键，`dialog.yes` 需要自行绑定。授权对话框中的 Esc 会拒绝调用并停止轮次。

| Action | 默认按键 | 行为 |
| --- | --- | --- |
| `dialog.up` | `up`、`shift+tab` | 上一个选项 |
| `dialog.down` | `down`、`tab` | 下一个选项 |
| `dialog.choose` | `enter` | 选择当前选项或提交输入 |
| `dialog.cancel` | `escape`、`ctrl+c` | 取消 |
| `dialog.yes` | 无 | 直接确认 |
| `dialog.no` | `n` | 拒绝确认 |
| `dialog.toggle` | `space` | 切换当前选项的勾选状态 |
| `dialog.prev-question` | `left` | 上一题 |
| `dialog.next-question` | `right` | 下一题，最多到首个尚未回答的问题 |

## 扩展视图

命令打开的全屏视图使用以下宿主 action，提示行显示当前绑定。空列表取消绑定，没有隐藏的 Esc 或 Ctrl+C 回退绑定，请保留离开视图的按键。

| Action | 默认按键 | 行为 |
| --- | --- | --- |
| `view.focus` | `f6`、`ctrl+tab` | 在视图与主输入框之间切换焦点，默认视图也可用；从原生聚焦的独立会话返回主会话。Ctrl+Tab 是终端能传递时可用的别名 |
| `view.back` | `escape` | 退出已激活的文本框、返回上一页或关闭根页面；取消视图中的输入提示 |
| `view.close` | `q`、`ctrl+c` | 关闭整个视图，包括嵌套页面 |
| `view.scroll-up` | `up` | 向上滚动视图文本一行 |
| `view.scroll-down` | `down` | 向下滚动视图文本一行 |

终端能传递 F6 时，F6（`view.focus`）在所有扩展视图与主输入框之间切换焦点，包括默认视图。终端能传递 Ctrl+Tab 时，它也是此 action 的别名。Windows Terminal 可能截获 Ctrl+Tab，旧式终端可能将其报告为普通 Tab。F6 可避开这些 Ctrl+Tab 问题，但 VS Code 集成终端默认会截获 F6，因为 `terminal.integrated.commandsToSkipShell` 中包含 `workbench.action.focusNextPart`。可在 VS Code 设置的 `terminal.integrated.commandsToSkipShell` 中添加 `"-workbench.action.focusNextPart"`，或将 Amira 的 `view.focus` 重新绑定到终端能传递的按键。单独的 Shift+Tab 不能绑定到 `view.focus`；它保留用于权限模式切换和视图反向导航。默认视图仍可用 Tab，提示继续显示 `tab→input/view`，不显示 F6。声明 `ViewDefinition.needsTab: true` 的视图保留 Tab 和 Shift+Tab 用于组件或视图导航；默认焦点提示显示 `f6→input/view`，而不是 Ctrl+Tab。子 agent 查看器使用此选项，所以 Tab/Shift+Tab 仍切换子 agent。宿主焦点切换从不占用 Shift+Tab。

视图获得焦点时，`/` 聚焦主输入框并输入 `/`，开始输入命令；`i` 只聚焦主输入框，不输入 `i`。视图处理的可打印快捷键（如 `m`、`p`、`s`）保持原样；其他未处理的可打印键会聚焦主输入框并输入该字符。已激活的视图内文本框和输入提示仍接收输入，包括 `/` 和 `i`。历史搜索期间，Esc 先取消搜索并恢复草稿；主输入框为空时，再按 Esc 将焦点返回视图或有可选择内容的停靠视图。不在搜索中时，空输入框中的 Esc 立即返回焦点；有文本时，Esc 保持原有行为，焦点切换不会截获它。视图中的 Esc 仍返回或关闭。点击主输入框会聚焦它。扩展视图旁获得焦点的输入框边框使用强调色角色，未获得焦点时使用弱化的边框；声明式视图中的选中行在视图非活动时变暗。

停靠视图默认聚焦主输入框。有可选择内容时，F6 进入停靠视图（终端能传递 Ctrl+Tab 时，它也是别名）；未声明 `needsTab: true` 时也可用 Tab。主输入框为空时，Esc 返回有可选择内容的停靠视图，与全屏视图相同；有文本时，Esc 仍关闭停靠视图并保留草稿。只读停靠视图不取得焦点，保持原有滚动行为，Esc 仍关闭它。对话框可见时，只允许在停靠区域上使用滚轮滚动；点击不会聚焦停靠视图或选择内容。

视图也使用下方共享的 `scroll.*` action，默认是 Shift+↑/↓、PgUp/PgDn 和 Home/End；重新绑定或取消绑定会同时影响对话记录和视图。独立的 `view.scroll-up`/`view.scroll-down` 保留视图中的普通方向键，不改变方向键调取输入历史的行为。要禁用视图中的所有逐行滚动，需同时取消视图和共享的逐行滚动绑定。扩展快捷键优先于滚动；`needsTab: true` 的组件视图用 Tab/Shift+Tab 切换组件，方向键和 Enter 仍导航和激活组件，滚动作用于获得焦点的可滚动区域。获得焦点的文本框接收可打印字符，包括 `q` 及可打印的返回/关闭绑定。Ctrl+C 等不可打印的关闭绑定仍可从文本框或输入提示中关闭视图；确认提示中的可打印键用于回答确认，不关闭视图。

## 对话记录（全屏模式）

全屏模式由 Amira 保存和滚动对话记录，下面的按键先于输入框处理。Home、End 和普通字符只在输入为空时操作对话记录，否则交给输入框。鼠标滚轮每格滚动三行，拖动选择文本；点击没有其他操作，键盘仍用于输入。选中对话块使用 `select.start`。

默认跟随最新输出。向上滚动后，新增内容不会改变当前位置，提示行显示下面还有多少行，如 `↓ 124 rows below`；新增内容后显示 `↓ new output · 124 rows below`。滚到底部或按 End 会恢复跟随。

| Action | 默认按键 | 行为 |
| --- | --- | --- |
| `scroll.up` | `shift+up` | 向上滚动一行 |
| `scroll.down` | `shift+down` | 向下滚动一行 |
| `scroll.page-up` | `pageup` | 向上翻页 |
| `scroll.page-down` | `pagedown` | 向下翻页 |
| `scroll.top` | `ctrl+home`、`home`、`alt+home`（VS Code 优先 `alt+home`） | 到对话开头 |
| `scroll.bottom` | `ctrl+end`、`end`、`alt+end`（VS Code 优先 `alt+end`） | 到末尾并恢复跟随 |
| `select.start` | `ctrl+up`、`alt+up`（VS Code 优先 `alt+up`） | 选中最新对话块，例如消息、回复、工具调用或通知 |
| `find` | `ctrl+f`、`alt+f`（VS Code 优先 `alt+f`） | 打开查找栏 |

## 对话块选择

选中块的第一列会出现标记，输入框上方显示其类型和位置，如 `reply 3 of 9`。选中部分可见的块不会触发滚动。输入或粘贴会回到输入框；选择模式不使用的按键，例如 Ctrl+C、Ctrl+O 和 Ctrl+D，仍按输入框的行为处理。

回复包含代码块时，`select.open` 进入第一个代码块，↑↓ 在代码块之间切换，`select.copy` 复制选中的原始代码，不带边框；`select.back` 或 Esc 返回整条回复。折叠的回复会先展开。对包含子 agent 的工具调用或后台子 agent 块，`select.open` 打开仍在运行的子 agent，否则打开最近一个；查看器中的 ←/→ 切换子 agent。

| Action | 默认按键 | 行为 |
| --- | --- | --- |
| `select.prev` | `up`、`ctrl+up`、`alt+up`、`k` | 上一个块 |
| `select.next` | `down`、`ctrl+down`、`alt+down`、`j` | 下一个块 |
| `select.toggle` | `enter`、`space` | 折叠或展开工具结果及其子 agent、较长代码块、回复中的 `<details>` |
| `select.copy` | `y`、`c` | 复制当前块或代码块 |
| `select.open` | `right`、`o` | 进入回复的代码块或打开子 agent 查看器 |
| `select.back` | `left` | 从代码块返回整条回复 |
| `select.exit` | `escape` | 退出选择；代码块中先返回整条回复 |

Ctrl+O（`tool-output`）在摘要 ↔ 完整之间切换；折叠级别会返回摘要。`/verbose collapsed` 仍可选择折叠，不带参数的 `/verbose` 仍按摘要 → 完整 → 折叠循环。完整级别也显示思考文本：正在进行的思考和保留的思考。思考提示仅在下一次按键可以显示文本时出现，并使用当前绑定的按键。手动折叠或展开过的块保留自己的显示级别。

## 文本选择与复制

全屏模式中，鼠标左键拖动由 Amira 选择文本，可以跨行和跨块。释放鼠标后通过 OSC 52 复制，提示行显示字符数。双击选中单词（含路径、URL 常用字符），三击选中行。拖动到记录底部以下，或从下方拖回顶部边缘，会自动滚动，按住越久滚动越快。

复制文本不包含界面装饰，例如消息前的 `›`、工具树的 `●`、`└` 和代码框边框。代码保留缩进，因宽度折行的代码重新拼回原行，整行选中时保留 Tab。图片复制为替代文本。其他文本按显示行复制，保留显示的列表和链接。超过约 100,000 字符的选区可能超过终端可接受大小，界面会提示。

对话继续输出、滚动时选区仍保留；点击、发送消息、选中块内容改变、折叠或工具显示级别改变、窗口大小改变会清除选区。输入仍发送到输入框。

| Action | 默认按键 | 行为 |
| --- | --- | --- |
| `text.clear` | `escape` | 清除文本选区。除正在回答对话框外，Esc 优先清除选区，再处理关闭列表、查找、历史搜索或中断等操作 |

复制快捷键使用 OSC 52，Windows Terminal、VS Code、iTerm2、kitty、WezTerm 等支持；tmux 需要 `set-clipboard on`。Amira 无法确认剪贴板是否实际收到了内容。全屏模式开启鼠标报告；要使用终端自己的文本选择，在 Windows Terminal、Windows/Linux 的 VS Code、xterm 中按住 Shift 拖动。macOS 的 VS Code 使用 Option，或设置 `terminal.integrated.macOptionClickForcesSelection`。鼠标粘贴也可能被报告给 Amira：Windows Terminal 中可按住 Shift 右键，Linux 终端可用 Shift+鼠标中键，也可按 Ctrl+V。

VS Code 自己处理 Ctrl+F、Ctrl+Home、Ctrl+End 和 Ctrl+↑↓（它们在 VS Code 的 `terminal.integrated.commandsToSkipShell` 中），不会传给终端程序，所以 Amira 在该环境优先显示 Alt+F、Alt+Home、Alt+End、Alt+↑。输入框的方向键、Home/End、Ctrl+A/Ctrl+E、单词移动和删除，以及 `/agents` 的 `p` 和查看器快捷键目前不能配置：←/→、Tab 切换，`x` 停止，`p` 关闭查看器并打印当前快照，`q` 或 Esc 关闭。

## 查找

查找栏随输入和新增对话实时搜索整个对话记录；没有大写字母时忽略大小写。跨显示行的文本作为同一行匹配，行间折行视为空格，不受窗口宽度影响。所有匹配项高亮，当前项额外加下划线，并显示序号，初始选中最新匹配。`/clear` 和 `/resume` 切换对话记录后，查找、复制和退出时打印只针对当前显示的会话。

| Action | 默认按键 | 行为 |
| --- | --- | --- |
| `find.next` | `enter`、`up`、`f3` | 更早的匹配 |
| `find.prev` | `shift+enter`、`down`、`shift+f3` | 更晚的匹配 |
| `find.close` | `escape`、`ctrl+c`、`ctrl+g` | 关闭查找栏并停留在当前匹配处 |

## 终端设置

以下设置位于用户或项目的 `settings.json` 中的 `tui` 对象。项目 `.amira/settings.json` 优先于用户设置；完整层级和选项见[设置参考](settings.md)。

| 设置 | 默认值 | 行为 |
| --- | --- | --- |
| `tui.mode` | `"fullscreen"` | 已弃用并被忽略；UI 始终在备用屏幕上全屏运行。在一个发布版本内，`"inline"` 和 `--inline` 会提示 `inline mode was removed; running fullscreen. Use -p for plain output.`。`--fullscreen` 仍被接受，但不执行任何操作。本次提示滚出视口后固定在标题栏下方；恢复的历史记录不显示固定提示。 |
| `tui.margin` | `3` | 左右留白宽度，单位为字符格（整数 0–12）；窄终端会自动缩小，尽可能保留至少 60 列内容。与 `tui.marginRows` 一起设为 `0` 可恢复贴边输出 |
| `tui.marginRows` | `1` | 全屏模式标题栏上方和按键提示行下方的空行数（整数 0–2）；终端不足 24 行时取消 |
| `tui.theme` | `"auto"` | [主题名称](themes.md)，或 `"auto"` 根据终端背景选择（无法判断时使用深色）；`"dark"` 和 `"light"` 显式指定 Amira 配色；`"terminal"` 使用终端自身的 ANSI 颜色 |
| `tui.themeVariant` | `"auto"` | 命名主题的深浅：`"auto"` 根据终端背景选择；`"dark"` 或 `"light"` 强制指定。缺少变体时使用所选外观的默认 Amira 配色 |
| `tui.colorDepth` | `"auto"` | 颜色深度：`"auto"` 检测终端支持情况；`"truecolor"`、`"256"` 和 `"16"` 手动指定。`"256"` 和 `"16"` 必须写成字符串，而不是数字 |
| `tui.title` | `true` | 设置终端标题；会话有标题时为 `Amira · <folder> · <session title> ⎇ <branch>`，运行期间显示 `●`，退出时恢复旧标题。标题栏使用系统字体，输入框状态不使用部分终端字体缺少的 `⎇` |
| `tui.progress` | `true` | 运行时显示终端标签或任务栏进度，对话框等待时显示暂停状态；使用 OSC 9;4，支持终端包括 Windows Terminal、ConEmu、VS Code、Ghostty |
| `tui.bell` | `true` | 终端在后台时，轮次结束或对话框打开会响铃；无法报告焦点的终端中，只在持续至少 15 秒的轮次之后响铃 |
| `tui.reflow` | `"auto"` | 已弃用并忽略；全屏模式会按当前终端宽度重新绘制对话 |
| `tui.submitWhileWorking` | `"steer"` | `"steer"` 让 Enter 引导当前轮次，`"queue"` 让 Enter 排队；排队键始终执行另一种行为。提示行同步更新，slash 命令始终立即执行 |
| `tui.images` | `"auto"` | 安装可选的 [`images`](https://github.com/CAMB-dev/amira-extensions/tree/main/extensions/images/README.md) 扩展后（`amira ext install images`；它读取本地文件，也能下载 http(s) 图片，沿用 web_fetch 的内网访问防护，单张最大 10 MB），在终端中绘制回复里独占一行的图片：`"auto"` 在终端声明支持时绘制，例如 Windows Terminal 1.22+（Sixel）、开启 `terminal.integrated.enableImages` 的 VS Code、iTerm2、WezTerm、kitty、Ghostty；`"on"` 始终绘制；`"off"` 从不绘制。其他情况下，以及图片加载失败或超过 3 秒时，显示为 `🖼` 加替代文本，并链接到图片 |
| `tui.shellOutputLines` | `3` | 成功的 shell 命令显示末尾若干行，运行时同样显示这些行；`0` 不显示。失败时显示首尾输出，Ctrl+O 切到 `full` 会显示全部 |

相关文档：[日常使用](usage.md)、[快速开始](getting-started.md)、[子 agent](subagents.md)、[设置参考](settings.md)。
