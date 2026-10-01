# Sub-agents

[简体中文](zh/subagents.md) · [Documentation](../README.md)

The bundled agent extension gives the model an `agent` tool for delegating tasks to separate agents and an `agent_result` tool for collecting results when needed. You ask for delegation in ordinary language; these are model tools, not slash commands.

For example: “Ask an explorer to trace the request handler and a reviewer to inspect the error paths. Continue checking the tests while they work.” Give each task a clear goal, relevant paths, constraints and the desired report.

## Tasks, roles and context

One `agent` call can start multiple tasks. Each needs a short title and complete prompt. A task can specify a role, model, context and isolation. Omitting the role starts a general agent with the parent's available tools.

| Built-in role | Purpose |
| --- | --- |
| `explorer` | Read-only research across the codebase |
| `coder` | Implement a clearly specified change with the available tools |
| `reviewer` | Read-only review for correctness problems |

Explorer and reviewer roles have a restricted tool list and instructions to use shell tools only for read-only commands. They are not operating-system sandboxes. By default, all roles work in the shared directory; even `coder` does not automatically get a worktree.

The default `context` is `"fresh"`: the child receives its task, role and project instructions, with its own conversation. Use `"fork"` when it needs the parent's conversation as well. A child reports its final answer and changes back to its parent. Do not rely on it having seen unmentioned conversation when using fresh context.

The model precedence is the task's `model`, then `agents.<role>.model` in settings, then the role file's `model`, then the parent's model. See [Settings](settings.md).

### Custom roles

Role files are Markdown under the user directory's `agents/` folder or the project's `.amira/agents/` folder. Project roles override user roles, which override built-in roles of the same name. Files with invalid frontmatter are reported and skipped.

For example, create `.amira/agents/test-reviewer.md`:

```markdown
---
name: test-reviewer
description: Review tests for missing cases
tools: [read, grep, glob]
---
Review the tests named in the task. Do not edit files.
Report missing cases with file paths and concrete examples.
```

Frontmatter supports `name`, `description`, `model`, `tools` and `isolation`. The name defaults to the filename; `model` uses provider/model, `tools` can be a list or a comma-separated string, and `isolation` accepts `none` or `worktree`. The body becomes the role's instructions. A role does not enable tools disabled in the parent session.

## Background runs and limits

By default, the main session's `agent` call returns immediately with child IDs, even if the model requests a blocking call. The children keep working while you talk to the main agent. Their reports arrive automatically: during a running turn they join before its next model request; while idle they start a follow-up turn. Reports finishing close together may arrive as one message.

`agent_result` does not wait in this default main-session mode; it reports progress or collects a result already available. A result is delivered once. Setting `subagents.background` to `false` restores blocking calls by default, with `background: true` still available on individual calls. A child agent's own calls wait by default; for background tasks it must collect results before finishing unless it is a persistent child managed by an extension.

Esc interrupts the main turn while its background children continue. Stop them with `/agents stop <n|id>` or `/agents stop all`. A manually stopped child's report waits for the next user message instead of starting a new model turn. `/clear`, switching sessions and exiting stop work belonging to the closed conversation. In [print and RPC modes](usage.md#print-mode), Amira waits for background results and the turns they start before exiting normally.

Defaults allow two nesting levels below the main agent and four working children **across the whole agent tree**; further tasks queue. Configure `subagents.maxDepth` and `subagents.maxConcurrent` to change them. A parent waiting on its children does not occupy a working slot. `budget.tokens` and `budget.costUsd` constrain the whole tree, including the main agent; no budget is set by default. Token budgets count input, output and cache reads and writes. Cost budgets depend on reported costs. Exceeding the budget stops live children and refuses new ones.

Approval requests from a child go to its parent's model. A child's questions are also answered by the parent, which can pass them to the user. See [Usage](usage.md#tools-and-approvals) for top-level approval dialogs.

## Listing and viewing

| Command | Action |
| --- | --- |
| `/agents` | Pick a child to view, or a kept worktree to review |
| `/agents <n|id>` | Print a child's transcript into the conversation |
| `/agents view` | View the latest running child, otherwise the latest child |
| `/agents view <n|id>` | Open that child's live viewer |
| `/agents stop <n|id>` | Stop one live child |
| `/agents stop all` | Stop all live children |
| `/agents worktrees` | List kept worktrees for this repository |

References can be a 1-based list number, full ID or unique ID prefix. Rows show title, role, state, elapsed time, tokens and cost when known. In the interactive picker, Enter opens a child; `p` prints its transcript instead. Print mode lists entries as text, and the live viewer requires the interactive UI.

The viewer updates as the child works. ←/→ or Tab/Shift+Tab switch children. `p` prints the displayed transcript, `x` asks to stop the displayed child and `y` confirms; another key cancels that stop. Esc, `q` or Ctrl+C closes the viewer. It also displays a reminder when a main-session dialog waits behind it. The viewer is available from either terminal mode; inline mode temporarily uses the alternate screen.

## Worktrees and merging

Ask the agent to use `isolation: "worktree"` for an implementation task, or give its role `isolation: worktree`. Amira creates a detached Git worktree from the parent's current tracked files, including uncommitted tracked changes. **Untracked files are not copied.** If worktree creation fails, including outside a Git repository or before its first commit, the task falls back to the shared directory and reports that fact.

A successfully finished child's changes are collected as a patch and applied to the parent's working tree. Clean patches apply automatically by default; merges are serialized. This does not create a commit on the parent's branch. `merge.reviewThreshold.lines` and `merge.reviewThreshold.files` can require review for a clean patch larger than either limit.

Conflicts open a diff review with these choices:

- `Apply what fits (.rej files for the rest)`: apply matching hunks, leave rejected hunks in `.rej` files and retain the worktree.
- `Keep in the worktree`: retain the files and patch for later review.
- `Discard`: remove the child's worktree and changes.

A clean patch requiring review offers `Merge` instead of partial application. Cancelling or being unable to answer keeps the worktree. Failed or stopped children keep their incomplete changes without merging them. The result identifies the worktree and patch paths. A shared-directory task's edits already affect your directory and have no isolated patch to merge.

Open `/agents` and choose a kept worktree to review its current diff, merge, keep or discard it. A later merge that conflicts applies nothing and retains the worktree. `/agents worktrees` only lists; it does not open the review picker.

Kept worktrees are subject to cleanup: after seven days of inactivity they are announced for deletion, with at least another day before removal. Cleanup runs when another child gets a worktree in this repository, rather than continuously. Choosing `Keep` restarts the retention period. Worktrees currently in use are excluded.

## Workflow and swarm extensions

Two official extensions build on sub-agents. They are not bundled with Amira; they live in [CAMB-dev/amira-extensions](https://github.com/CAMB-dev/amira-extensions) and install like any other package (see [Extensions](extensions.md)):

```sh
amira ext install workflow
amira ext install swarm
```

- [workflow](https://github.com/CAMB-dev/amira-extensions/tree/main/extensions/workflow/README.md) adds `/workflow` and a `workflow` tool: TypeScript scripts that orchestrate many sub-agents in the background (fan out, verify, pipelines), with a progress view (`/workflow view`) and resume from a journal. Scripts are saved under `.amira/workflows/` or in the user directory's `workflows/`. By default a run may start 30 agents in all, 6 at once.
- [swarm](https://github.com/CAMB-dev/amira-extensions/tree/main/extensions/swarm/README.md) adds `/swarm <goal>` and a `swarm` tool: a few long-lived members that work on one goal through a shared blackboard and messages, watched in `/swarm view`. Without a configured budget a swarm may spend 3,000,000 tokens.

You can ask for either one (`/workflow <task>`, `/swarm <goal>`, or in a message), and the model may propose one when it helps. By default every start asks you to confirm, showing the plan and its limits; where nobody can confirm, as in print mode, the model cannot start one. Only the main session can start them. Their settings live under `extensions.workflow` and `extensions.swarm` (`enabled`: `"ask"`, `"always"` or `"never"`, plus limits and a budget); their own limits apply within the tree's `subagents` and `budget` limits above. Each extension's README is the full reference.

Related: [Usage](usage.md) · [Settings](settings.md) · [Extensions](extensions.md) · [Keybindings](keybindings.md).
