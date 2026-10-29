# 前端协议

[English](../protocol.md) · [日本語](../ja/protocol.md) · [文档首页](../../README.zh-CN.md)

本页面向为 Amira 工作区 daemon 编写自有前端（例如桌面 GUI）的开发者。[远程工作区](remote-workspaces.md)中的全屏终端界面使用的也是同一协议。本文描述协议版本 **1**。

机器可读的契约是 JSON Schema [protocol/frontend-v1.schema.json](../protocol/frontend-v1.schema.json)（draft 2020-12）。它由 `scripts/gen-protocol-schema.ts` 根据 Amira 的运行时校验器生成，因此不会与 daemon 实际接受和发送的内容脱节。发送的帧用 `$defs/ClientFrame` 校验，收到的帧用 `$defs/ServerFrame` 校验。

## 公开范围

稳定且有文档的部分是前端使用的 **control 通道**：握手、下列操作的请求与响应、取消、事件与快照、UI 请求与表单、心跳和分块。schema 文件中的一切都受[版本与兼容性](#版本与兼容性)中的规则约束。

以下部分属于**内部实现**：它们在同一连接上存在，但本文不作说明，也不在 schema 中，任何版本都可能修改而不改变协议版本号。第三方客户端不得使用它们。

- `model` 通道（`model.open`、`model.stream`、`model.compact`，以及 `model.event` 和 `model.frame` 帧），以及 `proxy.describe` / `proxy.bind` 操作。它们通过终端客户端的本地 provider 密钥转发模型调用。
- `files` 通道：`files.*`、`images.*`、`artifacts.*` 和 `uploads.*`。
- daemon 的私有套接字、其前导消息和发现文件。客户端应通过 `amira-server attach` 连接（见[连接](#连接)）。

## 当前限制

规划客户端前请先阅读。这些是当前 daemon 的特性，而非线路格式本身的规定。

- **daemon 只在 Linux 上运行。**它就是 `amira remote add` 安装的服务端（glibc Linux，x64 或 ARM64）。Windows 和 macOS 上没有本地 daemon：终端界面在自身进程内运行 agent，因此那里的 GUI 只能经 SSH 访问 Linux 工作区。
- **每个工作区只有一个控制者。**daemon 同一时间只接受一个附加的前端。某个客户端持有控制权期间（以及断开后最多 30 秒内），其他客户端会以 `controller_busy` 被拒绝。GUI 和终端界面不能同时附加到同一工作区，也没有只读查看者模式。
- **模型路由。**以默认 local-proxy 模式启动的 daemon（`welcome.capabilities` 含 `model.proxy`）会等待终端客户端通过内部 model 通道处理模型调用。第三方客户端做不到这一点：轮次最多等待 `remote.proxyReconnectTimeoutMs`，然后失败。请附加到使用远程凭据（`model.remote-key`）的 daemon，即以 `amira-server attach --remote-key` 启动的 daemon。
- **变更记录上限。**daemon 会记住变更操作以便重试时只执行一次（见[请求与响应](#请求与响应)）。每个 daemon 生命周期内，所有客户端合计最多接受 4,096 个不同的变更 id，且同时最多保留 128 个变更操作（正在执行的，或在最近 10 分钟内完成的）。超过任一上限后，新的变更操作以 `limit_exceeded` 失败；重启 daemon（新的 `daemonEpoch`）会重置这些上限。另外，单个连接上使用满 65,536 个请求 id 后，daemon 会以 `limit_exceeded` 关闭该连接。

## 连接

客户端从不自行打开 daemon 套接字，而是启动中继命令，通过中继的 stdin 和 stdout 收发协议：

```sh
# On the Linux host itself
"$HOME/.amira/remote/bin/amira-server" attach --remote-key
# From another computer
ssh -T devbox '"$HOME/.amira/remote/bin/amira-server" attach --remote-key'
```

`amira remote add` 会把启动器安装到 `$HOME/.amira/remote/bin/amira-server`。中继会：

1. 在 5 秒内读取第一行，它必须是 `hello` 帧。
2. 把 `hello.workspace`（主机上已存在的绝对路径）解析为规范路径，`welcome.workspace` 会报告该路径。
3. 查找拥有该工作区的 daemon，或启动一个。`--remote-key` 只在中继启动新 daemon 时生效；正在运行的 daemon 保持其启动时的模型模式。
4. 在转发任何字节前检查 daemon：`/tmp/amira-<uid>-workspaces/` 下的发现文件和 `$XDG_RUNTIME_DIR/amira/`（或 `/tmp` 回退位置）下的套接字必须为该用户私有（目录 `0700`、文件 `0600`、属于该用户、无符号链接），并且已连接的套接字对端必须是记录中的 daemon 进程（相同的用户 ID、PID 和进程启动时间）。
5. 双向复制字节，直到任一方关闭。关闭中继即分离连接，绝不会停止 daemon 或其工作。

中继的 stdout 只承载协议帧。无法附加时，它写出一个 `reject` 帧后退出；详细信息只写入私有日志，绝不写到 stdout。

主机上的其他命令：

- `amira-server list` 在一行中输出 `{"v":1,"workspaces":[...]}`：当前用户每个存活 daemon 的工作区路径、`protocol`、服务端 `release` 和 `daemonEpoch`。
- `amira-server stop --cwd <workspace>` 停止 daemon 及其所有工作。它不是分离操作。

附加后，用 `sessions.list` 操作列出工作区内已保存的对话。

## 帧格式

- 每个帧是一个以 UTF-8 编码的 JSON 对象，后跟 `\n`（允许前面有一个 `\r`）。没有字节顺序标记，也没有其他分隔符。
- 换行符之前，一行最多 `lineBytes` = 262,144 字节。更大的帧（例如带图片的提示词或大快照）以 `chunk` 帧发送：先序列化该帧，把字节切成 131,072 字节的分片，按顺序逐片以 base64 编码发送，各片使用同一个新的 `transferId`，并带上 `index`、分片总数 `total`、完整字节长度 `bytes` 和完整字节的十六进制 SHA-256。接收方重组、校验哈希后处理内部帧。分块中不能再嵌套分块。
- 逻辑限制：一帧最多 `logicalBytes` = 67,108,864 字节，JSON 嵌套最多 64 层，最多 1,000,000 个 JSON 值，数字必须是有限值。同时最多 4 个分块传输，每个方向最多 128 个待处理请求。
- 客户端帧会被**严格**校验。未知字段、缺少必需字段、类型错误或超出 schema 的值都会导致连接关闭。握手之后服务端不会先发送错误，而是直接关闭。绝不要发送 schema 未列出的字段。

## 握手

客户端先发送 `hello`，并且必须等到 `welcome`（或 `reject`）后才能发送其他内容。

| `hello` 字段 | 含义 |
| --- | --- |
| `v` | 恒为 `1`。 |
| `clientId` | 本次附加的身份，1 到 128 个 `[A-Za-z0-9_.:-]` 字符。每次附加选一个随机值，恢复连接时沿用。 |
| `workspace` | 主机上工作区的绝对路径。 |
| `release` | 你的客户端自身的 `version`、`buildId` 和 `target`。服务端不解释它；可用来标识你的客户端（例如 `"buildId": "my-gui"`）。 |
| `limits` | 必须正好是 `{ "lineBytes": 262144, "logicalBytes": 67108864 }`。 |
| `capabilities` | 你能理解的可选行为（见下文）。未知字符串会被忽略。 |
| `resume` | 可选：来自先前 `welcome` 的 `daemonEpoch`、`after`（最后应用的事件 `seq`）和 `controllerToken`，用于重新连接。 |
| `snapshot` | 可选：`true` 表示即使在恢复连接时也要求一个 `reset` 快照。 |

`welcome` 返回服务端 `release`、规范的 `workspace` 及其 `workspaceId`、`daemonEpoch`、`controllerGeneration`、`sessionGeneration`、用于重新连接的 `controllerToken`（请保密）、相同的 `limits` 和服务端 `capabilities`：

| 能力 | 含义 |
| --- | --- |
| `frontend.v1` | 本文中的 control 通道操作。 |
| `replay`、`controller`、`mutation.ledger` | 恢复时的事件重放、控制者租约和重试请求去重。 |
| `jobs`、`conversations` | `jobs.*` 和 `conversations.*` 操作。 |
| `files`、`images` | 内部的 files 通道。 |
| `model.remote-key` / `model.proxy` | daemon 在哪里发起模型调用（见[当前限制](#当前限制)）。 |
| `context-window-source.provider` | 也是客户端能力，见[版本与兼容性](#版本与兼容性)。 |

协议没有版本协商。`v` 不同的 `hello` 会以 `reject` 代码 `incompatible_protocol` 被拒绝；附加到使用其他协议版本、正在运行的 daemon 时也一样。客户端必须检查 `welcome.v` 为 `1`，否则关闭连接。

`reject` 代码：`controller_busy`、`incompatible_protocol`、`invalid_frame`、`invalid_workspace`、`permission_denied`（例如重连凭据已过期）、`startup_failed`、`limit_exceeded`、`disconnected`、`unsupported_operation`、`operation_failed`。发送 `reject` 后连接即关闭。

## 请求与响应

`request` 携带 `channel`（`"control"`）、客户端选定的 `id`、`op`、`params`，以及该请求所针对的 `daemonEpoch`、`controllerGeneration` 和 `sessionGeneration`。使用 `welcome` 中的值；会话变化后，从每个快照中取新的 `sessionGeneration`（`frontend.sessionGeneration`）。务必发送 `daemonEpoch`：缺少它或属于其他 epoch 的请求会以 `outcome_unknown` 失败。请求 id 为 1 到 128 个 `[A-Za-z0-9_.:-]` 字符，同一连接上不得重复。变更操作的 id 还必须在整个 `daemonEpoch` 内对同一 `clientId` 唯一，跨重连也是如此：daemon 以 `clientId`、`daemonEpoch` 和 `id` 为键记录所有连接上的每个变更操作，且从不释放 id。请使用 UUID，或跨重连持续递增的计数器；以同一 `clientId` 恢复连接后，切勿把计数器从 `"1"` 重新开始。重复使用的 id 会得到先前保留的结果（参数相同），或以 `operation_conflict` 失败（参数不同），或以 `operation_expired` 失败（超过 10 分钟保留期），新请求都不会执行。

服务端对每个请求恰好回复一个带相同 `id` 和 `op` 的 `response`：要么 `"ok": true` 加 `result`，要么 `"ok": false` 加 `error: { code, message }`。响应可能以任意顺序到达，也可能夹在事件之间。schema 中的 `x-operations` 把每个操作映射到其 params 和 result 定义。

`cancel`（相同的 `channel`、`id`、`controllerGeneration` 和 `sessionGeneration`）会中止待处理的请求。被取消的请求可能收不到响应；迟到的响应应忽略。

`sessionGeneration` 不是当前值时，读操作以 `stale_session` 失败。变更操作按 `clientId` 和 `id` 记录：如果连接在响应到达前断开，请用 `resume` 重新连接，并以**相同的** `id` 和原来的 `daemonEpoch` 再次发送同一请求；daemon 会返回原来的结果，而不会执行两次。

| 领域 | 操作 |
| --- | --- |
| 状态 | `state.read`、`transcript.read`、`status.read`、`models.list`、`permissions.cycle`、`model.set`、`thinking.set`、`fastMode.set` |
| 轮次 | `turn.prompt`、`turn.steer`、`turn.abort` |
| 命令 | `command.run`、`skill.run`、`input.run`、`commands.describe`、`commands.complete` |
| 会话 | `sessions.list`、`sessions.read`、`session.resume`、`session.clear`、`session.fork`、`session.rewind`、`session.planRewind` |
| 子 agent 与对话 | `conversations.list`、`conversations.history`、`conversations.focus`、`conversations.unfocus`、`conversations.control`、`conversation.send`、`conversation.stop` |
| 后台任务 | `jobs.list`、`jobs.output`、`jobs.stop`、`jobs.wait` |
| UI 请求与表单 | `ui.respond`、`ui.cancel`、`form.open`、`form.evaluate`、`form.action`、`form.submit`、`form.cancel` |

`turn.prompt` 和 `turn.steer` 接受字符串，或内容包含文本块和图片块的用户消息。`command.run` 运行斜杠命令行，例如 `/clear`；`commands.describe` 和 `commands.complete` 提供命令列表和补全。

### 错误

`error.code` 稳定且可供程序判断；`message` 是展示文本，可能变化。客户端应处理的代码：

| 代码 | 含义 |
| --- | --- |
| `agent_busy` | agent 此刻无法接受该操作，例如轮次或压缩正在进行。 |
| `stale_session` | `sessionGeneration` 已不是当前值。请从最新快照刷新。 |
| `stale_operation` | 目标（UI 请求、表单或对话）已不再待处理或已不是当前目标。 |
| `stale_controller` | `controllerGeneration` 已不是当前值；本次附加已被替换。 |
| `outcome_unknown` | 请求属于另一个 `daemonEpoch`；daemon 已重启。请重新同步。 |
| `operation_conflict` | 同一个 `id` 被用于不同的 params。 |
| `operation_expired` | 重试的变更操作的原结果已不再保留。 |
| `unsupported_operation` | 此处不提供该操作。 |
| `cancelled`、`disconnected` | 请求已被取消，或工作区已将其分离。 |
| `limit_exceeded`、`invalid_frame` | 超出限制或校验失败。 |
| `operation_failed` | 其他任何失败。细节保留在主机上。 |

## 事件

服务端以 `event` 帧推送事件。`seq` 在同一 `daemonEpoch` 内计数，每次恰好加一；已应用过的 `seq` 应忽略，出现缺口则视为连接丢失。`replay: true` 标记恢复连接时重发的事件。

`reset` 携带完整的 `WorkspaceSnapshot`，取代客户端的全部状态；下一个事件的 `seq` 大于 `reset.seq`。新附加总是以 `reset` 开始（`reason: "fresh"`）。恢复连接时，服务端要么重放 `resume.after` 之后的事件，要么在以下情况发送 `reset`：epoch 已变（`epoch_changed`）、游标超出重放保留范围（`cursor_expired`，32 MiB 或 50,000 个事件）、游标超前（`future_cursor`）或捕获失败（`capture_failed`）。

事件 `payload` 要么是**核心事件**（含 `type`，例如 `turn.start`、`message.delta`、`tool.execute.end`、`ui.request`；其自身的 `seq` 按会话计数，与帧的 `seq` 无关），要么是**工作区通知**（含 `kind`）：

| `kind` | 含义 |
| --- | --- |
| `snapshot` | 每次变化后的完整前端快照（状态和对话记录）。 |
| `error` | 显示状态不可用（`invalid_snapshot`）。 |
| `semantic` | 状态栏条目、模型、子 agent 和分组。 |
| `jobs` | 后台任务列表。 |
| `inputQueue`、`steering`、`noticeInbox`、`noticeRetry`、`hold` | 各会话的排队输入和通知状态。 |
| `effect` | 命令请求的前端动作：`detach`、`rewind`、`unfocus`、`view` 或 `focus`。 |
| `startup` | 工作区的启动事件。 |

客户端可以发送 `ack`，`id` 设为 `daemonEpoch`，`seq` 设为最后应用的事件。它不得超过最后收到的 `seq`，也不得回退。

服务端每 15 秒发送一次 `id: "heartbeat"` 的 `ping`；每次都要回复带相同 `id` 的 `pong`，否则服务端会在 45 到 60 秒未收到回复后关闭连接。客户端也可以发送 ping，服务端会回复 `pong`。

## UI 请求

当 agent 需要回答（工具审批、提问、表单、扩展设置）时，服务端发出 `ui.request` 核心事件；待处理的请求也列在每个快照的 `pendingRequests` 中。用 `ui.respond { requestId, value }` 回答，或用 `ui.cancel` 关闭：

| `kind` | `value` |
| --- | --- |
| `select` | `options` 之一；若该选项所在分节定义了按键，也可以是 `{ "option", "key" }`。 |
| `confirm` | `true` 或 `false`；设置了 `always` 时可为 `"always"`；设置了 `other` 时可为 `{ "other": text }`。 |
| `input` | 字符串。 |
| `diff-review` | `options` 之一。 |
| `ask` | 每个问题一个回答：`{ "selected": [labels], "other"?: text }`。 |
| `extension-settings` | `{ "values": {...}, "scope": "user" \| "project" }`。 |
| `form` | 不使用 `ui.respond`。用 `form.open` 获取编辑器和修订号，编辑期间用 `form.evaluate`，动作字段用 `form.action`，最后用 `form.submit` 或 `form.cancel`。 |

确认结果为 `accepted`、`cancelled`、`settled`（已被回答）、`invalid` 或 `disconnected`。`ui.resolved` 事件告知所有前端某个请求已关闭。由于只有控制者处于附加状态，回答请求的就是它这一个前端。

## 版本与兼容性

在协议版本 1 内：

- 服务端只能在能力之后加入新操作、事件、通知类型、可选字段和枚举值，并且只发送给在 `hello.capabilities` 中列出该能力的客户端。例如上下文窗口来源的值 `"provider"`（见 `status.read` 和语义状态）只发送给声明了 `context-window-source.provider` 的客户端；其他客户端收到的数据中省略该字段。schema 在每个此类值的 `description` 中注明。
- 新的服务端能力出现在 `welcome.capabilities` 中；客户端只有看到对应能力后才使用可选操作。
- 客户端帧会被严格校验。客户端绝不能发送所连服务端版本的 schema 中没有的字段或值，即使是可选的也不行，除非服务端声明了引入它的能力。
- 破坏性变更（删除或重命名任何内容、改变类型、把可选字段改为必需、改变顺序或关联规则）需要新的协议版本和新的 schema 文件 `frontend-v2.schema.json`。daemon 以 `incompatible_protocol` 拒绝其他版本的客户端；旧客户端应告知用户需要更新客户端或服务端。没有降级模式。
- 为版本 1 构建的客户端在更新的版本 1 服务端上仍能工作：它不会看到自己没请求的字段，`welcome` 中的未知能力可以忽略。

为了健壮，生成的代码仍应容忍接收对象中的未知属性，但服务端不会向未声明相应能力的版本 1 客户端发送它们。

### 使用 schema

schema 是一个单一的包：每个类型都是 `$defs` 下的具名条目，只通过本地 `$ref` 引用，因此代码生成器（例如使用 `System.Text.Json` 的 C# 生成器）无需跨文件解析，并能得到稳定的类型名。`ClientFrame` 和 `ServerFrame` 是根类型。联合类型在不参与校验的 `x-discriminator` 关键字中给出其标签（`kind`、`type`、`op`、`role`、`status`、`state` 或 `action`）；`EventPayload` 根据是否含 `type`（核心事件）或 `kind` 区分。`x-operations` 把每个操作名映射到其 `params` 和 `result` 定义。整数是非负安全整数（最大 2^53 - 1）。字符串长度和模式遵循 JSON Schema 规则。

## 交换示例

以下是与使用模拟模型的 daemon 之间的一次完整交换；线路上每个 JSON 对象占一行（此处为便于阅读而格式化，并省略了部分事件，所以 `seq` 不连续）。Amira 的测试会用 schema 校验下面每一个帧。

<!-- protocol-example:start -->

<!-- client -->

```json
{
  "v": 1,
  "kind": "hello",
  "clientId": "example-gui-1",
  "workspace": "/home/dev/project",
  "release": {
    "version": "0.1.0",
    "buildId": "example-gui",
    "target": "win32-x64"
  },
  "limits": {
    "lineBytes": 262144,
    "logicalBytes": 67108864
  },
  "capabilities": [
    "context-window-source.provider"
  ]
}
```

<!-- server -->

```json
{
  "v": 1,
  "kind": "welcome",
  "release": {
    "version": "0.0.1",
    "buildId": "0123456789abcdef0123456789abcdef01234567",
    "target": "bun-linux-x64-baseline"
  },
  "workspace": "/home/dev/project",
  "workspaceId": "1afbf223bb0b58ba08766ec87173ebd68e0507d66983531a95b52ff9b529c7db",
  "daemonEpoch": "f0b76d8d-e080-42f7-8a17-73c5811ee066",
  "controllerGeneration": 1,
  "controllerToken": "9c1f000000000000000000000000000000000000000000000000000000000000",
  "sessionGeneration": 1,
  "limits": {
    "lineBytes": 262144,
    "logicalBytes": 67108864
  },
  "capabilities": [
    "context-window-source.provider",
    "frontend.v1",
    "replay",
    "controller",
    "mutation.ledger",
    "files",
    "images",
    "jobs",
    "conversations",
    "model.remote-key"
  ]
}
```

<!-- server -->

```json
{
  "v": 1,
  "kind": "reset",
  "daemonEpoch": "f0b76d8d-e080-42f7-8a17-73c5811ee066",
  "seq": 2,
  "reason": "fresh",
  "snapshot": {
    "frontend": {
      "sessionGeneration": 1,
      "state": {
        "sessionId": "s_689ca598",
        "cwd": "/home/dev/project",
        "resumed": false,
        "status": "idle",
        "model": {
          "provider": "mock",
          "id": "test",
          "contextWindow": 128000,
          "caps": {
            "images": false
          }
        },
        "permissionMode": "auto",
        "fastMode": {
          "requested": false,
          "applied": false
        },
        "children": 0
      },
      "transcript": {
        "messages": [],
        "displays": []
      }
    },
    "owners": {
      "s_689ca598": {
        "status": "idle",
        "busy": false,
        "turnId": null,
        "hold": null,
        "inputQueue": [],
        "steering": [],
        "noticeInbox": {
          "queue": [],
          "expected": 0
        },
        "noticeRetry": null
      }
    },
    "pendingRequests": [],
    "jobs": [],
    "startupEvents": [],
    "activity": {
      "events": [
        {
          "seq": 1,
          "ts": 1793271055136,
          "sessionId": "s_689ca598",
          "type": "session.start",
          "data": {
            "reason": "startup",
            "cwd": "/home/dev/project",
            "model": {
              "provider": "mock",
              "model": "test"
            }
          }
        }
      ]
    },
    "semantic": {
      "status": {
        "info": {
          "id": "s_689ca598",
          "cwd": "/home/dev/project",
          "model": {
            "provider": "mock",
            "model": "test"
          },
          "supportsThinking": false,
          "fastMode": {
            "requested": false,
            "applied": false
          },
          "contextWindow": 128000,
          "contextWindowSource": "default",
          "busy": false,
          "shell": "auto",
          "permissions": {
            "mode": "auto",
            "rules": 0
          }
        },
        "items": [],
        "usage": {
          "input": 0,
          "output": 0,
          "cacheRead": 0,
          "cacheWrite": 0
        }
      },
      "models": [
        {
          "ref": "mock/test",
          "provider": "mock",
          "id": "test",
          "contextWindow": 128000,
          "maxOutput": 8192,
          "caps": {
            "tools": "native",
            "images": false,
            "thinking": false,
            "promptCache": false,
            "parallelToolCalls": true
          },
          "available": true
        }
      ],
      "subagents": [],
      "groups": []
    }
  }
}
```

<!-- client -->

```json
{
  "v": 1,
  "kind": "request",
  "channel": "control",
  "daemonEpoch": "f0b76d8d-e080-42f7-8a17-73c5811ee066",
  "controllerGeneration": 1,
  "sessionGeneration": 1,
  "id": "1",
  "op": "state.read",
  "params": {}
}
```

<!-- server -->

```json
{
  "v": 1,
  "kind": "response",
  "channel": "control",
  "id": "1",
  "op": "state.read",
  "ok": true,
  "result": {
    "sessionId": "s_689ca598",
    "cwd": "/home/dev/project",
    "resumed": false,
    "status": "idle",
    "model": {
      "provider": "mock",
      "id": "test",
      "contextWindow": 128000,
      "caps": {
        "images": false
      }
    },
    "permissionMode": "auto",
    "fastMode": {
      "requested": false,
      "applied": false
    },
    "children": 0
  }
}
```

<!-- client -->

```json
{
  "v": 1,
  "kind": "request",
  "channel": "control",
  "daemonEpoch": "f0b76d8d-e080-42f7-8a17-73c5811ee066",
  "controllerGeneration": 1,
  "sessionGeneration": 1,
  "id": "2",
  "op": "turn.prompt",
  "params": {
    "message": "Say hello."
  }
}
```

<!-- server -->

```json
{
  "v": 1,
  "kind": "event",
  "daemonEpoch": "f0b76d8d-e080-42f7-8a17-73c5811ee066",
  "seq": 3,
  "payload": {
    "seq": 2,
    "ts": 1793271055197,
    "sessionId": "s_689ca598",
    "turnId": "t_7225c408",
    "type": "turn.start",
    "data": {
      "prompt": {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": "Say hello."
          }
        ]
      }
    }
  }
}
```

<!-- server -->

```json
{
  "v": 1,
  "kind": "response",
  "channel": "control",
  "id": "2",
  "op": "turn.prompt",
  "ok": true,
  "result": {
    "sessionGeneration": 1
  }
}
```

<!-- server -->

```json
{
  "v": 1,
  "kind": "event",
  "daemonEpoch": "f0b76d8d-e080-42f7-8a17-73c5811ee066",
  "seq": 10,
  "payload": {
    "seq": 5,
    "ts": 1793271055215,
    "sessionId": "s_689ca598",
    "turnId": "t_7225c408",
    "type": "message.delta",
    "data": {
      "kind": "text",
      "text": "Hello fr"
    }
  }
}
```

<!-- server -->

```json
{
  "v": 1,
  "kind": "event",
  "daemonEpoch": "f0b76d8d-e080-42f7-8a17-73c5811ee066",
  "seq": 15,
  "payload": {
    "seq": 10,
    "ts": 1793271055221,
    "sessionId": "s_689ca598",
    "turnId": "t_7225c408",
    "type": "message.end",
    "data": {
      "message": {
        "role": "assistant",
        "content": [
          {
            "type": "text",
            "text": "Hello from the mock model."
          }
        ],
        "model": {
          "provider": "mock",
          "model": "test"
        },
        "usage": {
          "input": 0,
          "output": 0,
          "cacheRead": 0,
          "cacheWrite": 0
        },
        "stopReason": "end"
      }
    }
  }
}
```

<!-- server -->

```json
{
  "v": 1,
  "kind": "event",
  "daemonEpoch": "f0b76d8d-e080-42f7-8a17-73c5811ee066",
  "seq": 19,
  "payload": {
    "seq": 12,
    "ts": 1793271055226,
    "sessionId": "s_689ca598",
    "turnId": "t_7225c408",
    "type": "turn.end",
    "data": {
      "reason": "done",
      "steps": 1
    }
  }
}
```

<!-- client -->

```json
{
  "v": 1,
  "kind": "ack",
  "channel": "control",
  "id": "f0b76d8d-e080-42f7-8a17-73c5811ee066",
  "seq": 19
}
```

<!-- protocol-example:end -->

`turn.end` 之后服务端还会继续推送：状态回到 `idle`，最后一个 `snapshot` 通知携带包含助手回复的对话记录。
