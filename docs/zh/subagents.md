# 子 agent

[English](../subagents.md) · [文档首页](../../README.zh-CN.md)

内置 agent 扩展向模型提供 `agent` 工具，用于将任务交给独立的子 agent；需要收取结果时使用 `agent_result`。直接用自然语言要求分工即可，这两个名字是模型工具，不是斜杠命令。

例如：“让一个 explorer 追踪请求处理流程，再让一个 reviewer 检查错误路径。它们工作时，你继续检查测试。” 每个任务应说明目标、相关路径、限制和期望的报告内容。

## 任务、角色与上下文

一次 `agent` 调用可以启动多个任务，每个任务必须有简短标题和完整提示词，也可以指定角色、模型、上下文和隔离方式。不指定角色时，启动可使用父 agent 当前工具的通用子 agent。

| 内置角色 | 用途 |
| --- | --- |
| `explorer` | 只读研究代码库 |
| `coder` | 使用可用工具实现明确的改动 |
| `reviewer` | 只读审查代码正确性 |

explorer 和 reviewer 的工具列表受到限制，指令要求 shell 命令只能读取内容；这些角色并不是操作系统沙盒。所有角色默认共用工作目录，`coder` 也不会自动获得 worktree。

`context` 默认是 `"fresh"`：子 agent 有自己的对话，获得任务、角色和项目指令。如果需要父 agent 的对话内容，使用 `"fork"`。子 agent 会把最终回答和改动情况交给父 agent；使用 fresh 上下文时，应在任务中写清必要信息，不能假定它看过之前的对话。

模型选择优先级为：任务的 `model`、设置中的 `agents.<role>.model`、角色文件的 `model`，最后是父 agent 的模型。参见[设置](settings.md)。

### 自定义角色

角色文件为 Markdown，放在用户目录的 `agents/` 或项目的 `.amira/agents/` 中。同名角色依次由项目角色覆盖用户角色，用户角色覆盖内置角色。frontmatter 无效的文件会被报告并跳过。

例如创建 `.amira/agents/test-reviewer.md`：

```markdown
---
name: test-reviewer
description: Review tests for missing cases
tools: [read, grep, glob]
---
Review the tests named in the task. Do not edit files.
Report missing cases with file paths and concrete examples.
```

frontmatter 支持 `name`、`description`、`model`、`tools` 和 `isolation`。名称默认取文件名；`model` 使用 provider/model；`tools` 可以是列表或逗号分隔的字符串；`isolation` 为 `none` 或 `worktree`。正文成为角色指令。角色不能重新启用父会话中已禁用的工具。

## 后台运行与限制

默认情况下，主会话的 `agent` 调用立即返回子 agent ID，即使模型要求同步等待也是如此。你可以继续和主 agent 交谈，子 agent 在后台工作。结果自动返回：主轮次仍在运行时，结果会在下一次模型请求前加入；主 agent 空闲时，结果会启动后续轮次。完成时间接近的报告可能合并为一条消息。

主会话采用默认后台模式时，`agent_result` 不会阻塞等待，只报告进度或收取已经完成的结果，每份结果只投递一次。设置 `subagents.background` 为 `false` 后，调用恢复为默认等待，也可在单次调用中使用 `background: true`。子 agent 自己发起的调用默认等待；如果在后台启动任务，通常必须在结束前收取结果，除非它是由扩展管理的持久子 agent。

Esc 只打断主轮次，其后台子 agent 会继续运行。用 `/agents stop <n|id>` 停止一个，或 `/agents stop all` 停止全部。手动停止的子 agent 的报告会等待下一条用户消息，不会主动启动新的模型轮次。`/clear`、切换会话和退出会停止已关闭对话的后台工作。[打印和 RPC 模式](usage.md#打印模式)在正常退出前会等待后台结果及其触发的轮次。

默认允许主 agent 下面嵌套两层子 agent，**整个 agent 树**最多同时有四个工作中的子 agent，其余任务排队。用 `subagents.maxDepth` 与 `subagents.maxConcurrent` 修改限制。等待子任务的父 agent 不占工作名额。`budget.tokens` 与 `budget.costUsd` 限制整个 agent 树，包括主 agent；默认不设预算。token 预算包含输入、输出、缓存读取和写入；费用预算依赖上报费用。预算超限会停止仍在运行的子 agent，并拒绝启动新的子 agent。

子 agent 的审批请求交给父 agent 的模型决定；问题也先由父 agent 回答，父 agent 可以转交给用户。主会话审批界面见[使用说明](usage.md#工具与审批)。

## 列表与查看器

| 命令 | 操作 |
| --- | --- |
| `/agents` | 选择子 agent 查看，或审查保留的 worktree |
| `/agents <n|id>` | 将子 agent 的对话记录输出到主对话 |
| `/agents view` | 查看最近的运行中子 agent，没有则查看最近一个 |
| `/agents view <n|id>` | 打开指定子 agent 的实时查看器 |
| `/agents stop <n|id>` | 停止指定子 agent |
| `/agents stop all` | 停止所有尚未结束的子 agent |
| `/agents worktrees` | 列出当前仓库保留的 worktree |

可以用从 1 开始的列表序号、完整 ID 或唯一的 ID 前缀定位。列表显示标题、角色、状态、耗时、token，以及已知费用。交互选择器中 Enter 打开查看器，`p` 将对话记录输出到主对话。打印模式以文本列出项目；实时查看器需要交互界面。

查看器随子 agent 工作实时更新。←/→ 或 Tab/Shift+Tab 切换子 agent，`p` 输出当前对话记录；`x` 请求停止当前子 agent，接着 `y` 确认，其他键取消停止。Esc、`q` 或 Ctrl+C 关闭查看器。主会话有待回答的对话框时，查看器会显示提醒。两种终端模式都能打开查看器，内联模式会暂时切到备用屏幕。

## Worktree 与合并

可以要求 agent 对实现任务使用 `isolation: "worktree"`，或在角色中设置 `isolation: worktree`。Amira 基于父 agent 当前已跟踪的文件创建 detached Git worktree，包含已跟踪文件的未提交改动，**不复制未跟踪文件**。如果创建失败，例如不在 Git 仓库中或仓库还没有提交，任务会退回共享目录运行，并在报告中说明。

成功完成的子 agent 会将改动收集为补丁，应用到父 agent 工作区。默认自动应用无冲突补丁，多个合并依次执行；不会在父 agent 分支上创建提交。`merge.reviewThreshold.lines` 和 `merge.reviewThreshold.files` 可要求超过任一阈值的无冲突补丁也进入审查。

冲突时打开 diff 审查，提供以下选项：

- `Apply what fits (.rej files for the rest)`：应用能够匹配的部分，拒绝的部分写入 `.rej` 文件，并保留 worktree。
- `Keep in the worktree`：保留文件和补丁，稍后处理。
- `Discard`：删除子 agent 的 worktree 和改动。

需要审查的无冲突补丁提供 `Merge`，而非部分应用。取消审查或无法回答时会保留 worktree。失败或停止的子 agent 也保留未完成的改动，不自动合并；结果会说明 worktree 与补丁路径。共享目录中的任务直接修改当前目录，没有隔离补丁可供合并。

打开 `/agents` 并选中保留的 worktree，可以审查当前 diff，再选择合并、保留或丢弃。后续合并若有冲突，不会应用任何内容，worktree 继续保留。`/agents worktrees` 仅列出条目，不打开审查选择器。

保留的 worktree 会参与清理：七天未活动后先公告删除，至少再过一天才删除。清理在当前仓库另一个子 agent 获得 worktree 时执行，并非持续后台运行。选择 `Keep` 会重新开始保留期限，正在使用的 worktree 不参与清理。

## Workflow 与 swarm 扩展

有两个官方扩展基于子 agent 构建。它们不随 Amira 内置，而是放在 [CAMB-dev/amira-extensions](https://github.com/CAMB-dev/amira-extensions) 仓库中，和其他扩展包一样安装（见[扩展](extensions.md)）：

```sh
amira ext install workflow
amira ext install swarm
```

- [workflow](https://github.com/CAMB-dev/amira-extensions/tree/main/extensions/workflow/README.md) 提供 `/workflow` 命令和 `workflow` 工具：用 TypeScript 脚本在后台编排大量子 agent（并行分派、交叉验证、流水线），可以用 `/workflow view` 查看进度，并能根据日志恢复运行。脚本保存在 `.amira/workflows/` 或用户目录的 `workflows/` 下。默认每次运行最多启动 30 个 agent，同时工作的最多 6 个。
- [swarm](https://github.com/CAMB-dev/amira-extensions/tree/main/extensions/swarm/README.md) 提供 `/swarm <goal>` 命令和 `swarm` 工具：几个长期运行的成员通过共享黑板和消息围绕同一目标协作，可以在 `/swarm view` 中观察。未配置预算时，一个 swarm 最多消耗 3,000,000 token。

你可以主动要求使用（`/workflow <task>`、`/swarm <goal>` 或直接在消息里说明），模型也可能在合适时提议。默认情况下，每次启动都会请你确认，并显示计划和限制；在打印模式等无人确认的场景下，模型无法启动它们。只有主会话可以启动。相关设置位于 `extensions.workflow` 和 `extensions.swarm`（`enabled` 可取 `"ask"`、`"always"` 或 `"never"`，另有各自的限制和预算）；这些限制都在上文 agent 树的 `subagents` 和 `budget` 限制之内生效。完整说明见各扩展的 README。

相关文档：[使用说明](usage.md) · [设置](settings.md) · [扩展](extensions.md) · [快捷键](keybindings.md)。
