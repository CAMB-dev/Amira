# 快捷键

[English](../keybindings.md) · [文档首页](../../README.zh-CN.md)

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
| `interrupt` | `escape` | 有命令正在运行时先取消命令并保留输入；否则中断轮次。有等待中的引导或排队消息时，按原输入顺序合并并立即发送。连续按两次（空闲时也可以）打开回退选择器，按时间倒序列出用户消息；选中消息及其后续对话会被移除，选中消息回到输入框供修改。不会恢复文件 |
| `cancel` | `ctrl+c` | 有命令正在运行时先取消命令并保留输入；否则在运行时中断轮次；等待消息的处理与 `interrupt` 相同。空闲时先清空输入，输入已空则退出 |
| `exit` | `ctrl+d` | 输入为空且没有轮次运行时退出 |
| `redraw` | `ctrl+l` | 清屏并重新绘制最新对话记录和输入框 |
| `history.prev` | `up` | 光标在输入首行时调出上一条提示词 |
| `history.next` | `down` | 光标在输入末行时调出下一条提示词 |
| `history.search` | `ctrl+r` | 搜索提示词历史 |
| `tool-output` | `ctrl+o` | 切换工具结果的显示量，与 `/verbose` 相同 |
| `panels.toggle` | `ctrl+t` | 把活动行上方的实时面板折叠为一行，或展开 |
| `copy.reply` | `alt+c` | 将会话最后一条回复按 Markdown 复制到剪贴板，两种界面模式都可用 |
| `help` | `?` | 输入为空且没有对话框或列表时打开按键参考；输入有文本时作为普通字符输入 |
| `edit.kill-to-start` | `ctrl+u` | 剪切行首到光标的文本；在行首则剪切前一个换行 |
| `edit.kill-to-end` | `ctrl+k` | 剪切光标到行尾的文本；在行尾则剪切后一个换行 |
| `edit.kill-word` | `ctrl+w` | 剪切光标前的单词 |
| `edit.yank` | `ctrl+y` | 粘贴最后剪切的文本；连续剪切会合并，折叠的粘贴内容仍保持折叠 |
| `edit.undo` | `ctrl+z` | 撤销最近一次输入操作，包括输入、连续删除、剪切、粘贴或历史调取 |
| `edit.redo` | `ctrl+shift+z` | 重做。没有 kitty keyboard protocol 的终端可能把它报告为 Ctrl+Z，需要另行绑定 |
| `edit.external` | `ctrl+g` | 用 `$VISUAL`、其次 `$EDITOR` 指定的命令编辑消息（如 `code --wait`）；未指定则 Windows 使用 Notepad，其他系统使用 vi。编辑器退出后，保存的文本回到输入框 |

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

在 `/ext` 中，Enter 管理选中的已安装扩展，或从索引安装选中的扩展；`d` 显示选中扩展的详情。直接输入可以过滤列表，过滤框有文字后 `d` 也会作为过滤文字。安装和更新期间输入框仍可使用，并显示实时进度面板。不在对话框或补全列表中时，Esc（`interrupt`）或 Ctrl+C（`cancel`）取消正在运行的命令并保留草稿，已完成的改动保持安装状态。提示行使用当前的快捷键绑定。改动在空闲时运行 `/reload` 后生效。

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

## 对话记录（全屏模式）

全屏模式由 Amira 保存和滚动对话记录，下面的按键先于输入框处理。Home、End 和普通字符只在输入为空时操作对话记录，否则交给输入框。鼠标滚轮每格滚动三行，拖动选择文本；点击没有其他操作，键盘仍用于输入。选中对话块使用 `select.start`。inline 模式由终端保存滚动历史，首次按查找、翻页或选择按键时会提示这些操作仅用于全屏模式，请使用终端自己的滚动和查找。

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

Ctrl+O（`tool-output`）设置所有工具调用的显示量；手动折叠或展开过的调用保留自己的显示级别。

## 文本选择与复制

全屏模式中，鼠标左键拖动由 Amira 选择文本，可以跨行和跨块。释放鼠标后通过 OSC 52 复制，提示行显示字符数。双击选中单词（含路径、URL 常用字符），三击选中行。拖动到记录底部以下，或从下方拖回顶部边缘，会自动滚动，按住越久滚动越快。

复制文本不包含界面装饰，例如消息前的 `›`、工具树的 `●`、`└` 和代码框边框。代码保留缩进，因宽度折行的代码重新拼回原行，整行选中时保留 Tab。图片复制为替代文本。其他文本按显示行复制，保留显示的列表和链接。超过约 100,000 字符的选区可能超过终端可接受大小，界面会提示。

对话继续输出、滚动时选区仍保留；点击、发送消息、选中块内容改变、折叠或工具显示级别改变、窗口大小改变会清除选区。输入仍发送到输入框。

| Action | 默认按键 | 行为 |
| --- | --- | --- |
| `text.clear` | `escape` | 清除文本选区。除正在回答对话框外，Esc 优先清除选区，再处理关闭列表、查找、历史搜索或中断等操作 |

复制快捷键使用 OSC 52，Windows Terminal、VS Code、iTerm2、kitty、WezTerm 等支持；tmux 需要 `set-clipboard on`。Amira 无法确认剪贴板是否实际收到了内容。全屏模式开启鼠标报告；要使用终端自己的文本选择，在 Windows Terminal、Windows/Linux 的 VS Code、xterm 中按住 Shift 拖动。macOS 的 VS Code 使用 Option，或设置 `terminal.integrated.macOptionClickForcesSelection`。鼠标粘贴也可能被报告给 Amira：Windows Terminal 中可按住 Shift 右键，Linux 终端可用 Shift+鼠标中键，也可按 Ctrl+V。inline 模式直接使用终端的选择和粘贴。

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
| `tui.mode` | `"fullscreen"` | `"fullscreen"` 使用 alternate screen，由 Amira 滚动、查找、折叠和复制，窗口改变时重绘，退出或崩溃时打印到普通屏幕；`"inline"` 将完成的输出留在终端滚动历史中。`--inline` 和 `--fullscreen` 优先 |
| `tui.title` | `true` | 设置终端标题 `Amira · <folder> ⎇ <branch>`，运行期间显示 `●`，退出时恢复旧标题。标题栏使用系统字体，输入框状态不使用部分终端字体缺少的 `⎇` |
| `tui.progress` | `true` | 运行时显示终端标签或任务栏进度，对话框等待时显示暂停状态；使用 OSC 9;4，支持终端包括 Windows Terminal、ConEmu、VS Code、Ghostty |
| `tui.bell` | `true` | 终端在后台时，轮次结束或对话框打开会响铃；无法报告焦点的终端中，只在持续至少 15 秒的轮次之后响铃 |
| `tui.reflow` | `"auto"` | inline 模式中，`"off"` 用于缩窄时不会重新折行的终端，以避免擦除输入框上方的记录；`"auto"` 和 `"on"` 假定终端会重新折行 |
| `tui.submitWhileWorking` | `"steer"` | `"steer"` 让 Enter 引导当前轮次，`"queue"` 让 Enter 排队；排队键始终执行另一种行为。提示行同步更新，slash 命令始终立即执行 |
| `tui.images` | `"auto"` | 安装可选的 [`images`](https://github.com/CAMB-dev/amira-extensions/tree/main/extensions/images/README.md) 扩展后（`amira ext install images`；它读取本地文件，也能下载 http(s) 图片，沿用 web_fetch 的内网访问防护，单张最大 10 MB），在终端中绘制回复里独占一行的图片：`"auto"` 在终端声明支持时绘制，例如 Windows Terminal 1.22+（Sixel）、开启 `terminal.integrated.enableImages` 的 VS Code、iTerm2、WezTerm、kitty、Ghostty；`"on"` 始终绘制；`"off"` 从不绘制。其他情况下，以及图片加载失败或超过 3 秒时，显示为 `🖼` 加替代文本，并链接到图片 |
| `tui.shellOutputLines` | `3` | 成功的 shell 命令显示末尾若干行，运行时同样显示这些行；`0` 不显示。失败时显示首尾输出，Ctrl+O 切到 `full` 会显示全部 |

相关文档：[日常使用](usage.md)、[快速开始](getting-started.md)、[子 agent](subagents.md)、[设置参考](settings.md)。
