# Frontend protocol

[简体中文](zh/protocol.md) · [日本語](ja/protocol.md) · [Documentation](../README.md)

This page is for people writing their own frontend (for example a desktop GUI) for an Amira workspace daemon. The fullscreen terminal UI uses the same protocol in [remote workspaces](remote-workspaces.md). Protocol version **1** is described here.

The machine-readable contract is the JSON Schema [protocol/frontend-v1.schema.json](protocol/frontend-v1.schema.json) (draft 2020-12). It is generated from Amira's runtime validators by `scripts/gen-protocol-schema.ts`, so it cannot drift from what the daemon accepts and sends. Validate frames you send with `$defs/ClientFrame` and frames you receive with `$defs/ServerFrame`.

## What is public

The stable, documented surface is the **control channel** used by a frontend: the handshake, requests and responses for the operations listed below, cancellation, events and snapshots, UI requests and forms, heartbeats and chunking. Everything in the schema file is covered by the compatibility rules in [Versioning](#versioning-and-compatibility).

These parts are **internal**: they exist on the same connection but are not documented here, are not in the schema, and can change in any release without a protocol version change. A third-party client must not use them.

- The `model` channel (`model.open`, `model.stream`, `model.compact`, `model.event` and `model.frame` frames) and the `proxy.describe` / `proxy.bind` operations, which route model calls through the terminal client's local provider keys.
- The `files` channel: `files.*`, `images.*`, `artifacts.*` and `uploads.*`.
- The private daemon socket, its prelude and the discovery files. Clients connect through `amira-server attach` instead (see [Connecting](#connecting)).

## Current limits

Read these before planning a client. They are properties of the current daemon, not of the wire format.

- **The daemon runs on Linux only.** It is the server installed by `amira remote add` (glibc Linux, x64 or ARM64). On Windows and macOS there is no local daemon: the terminal UI runs the agent in its own process, so a GUI there can only reach a Linux workspace over SSH.
- **One controller per workspace.** A daemon accepts one attached frontend at a time. While a client holds the controller (and for up to 30 seconds after it disconnects), another client is refused with `controller_busy`. A GUI and the terminal UI cannot be attached to the same workspace at the same time, and there is no read-only viewer.
- **Model routing.** A daemon started in the default local-proxy mode (`model.proxy` in `welcome.capabilities`) waits for the terminal client to serve model calls over the internal model channel. A third-party client cannot do that: turns wait up to `remote.proxyReconnectTimeoutMs` and then fail. Attach to daemons that use remote credentials (`model.remote-key`), started with `amira-server attach --remote-key`.
- **Mutation ledger caps.** The daemon remembers mutations for exactly-once retries (see [Requests and responses](#requests-and-responses)). It accepts at most 4,096 distinct mutation ids per daemon lifetime across all clients, and retains at most 128 mutations (running, or completed within the last 10 minutes) at once. Past either cap, new mutations fail with `limit_exceeded`; restarting the daemon (a new `daemonEpoch`) resets them. Separately, after 65,536 request ids on one connection, the daemon closes the connection with `limit_exceeded`.

## Connecting

A client never opens the daemon socket itself. It starts the relay command and speaks the protocol over the relay's stdin and stdout:

```sh
# On the Linux host itself
"$HOME/.amira/remote/bin/amira-server" attach --remote-key
# From another computer
ssh -T devbox '"$HOME/.amira/remote/bin/amira-server" attach --remote-key'
```

`amira remote add` installs the launcher at `$HOME/.amira/remote/bin/amira-server`. The relay:

1. Reads the first line, which must be the `hello` frame, within 5 seconds.
2. Resolves `hello.workspace` (an existing absolute path on the host) to its canonical path. `welcome.workspace` reports that path.
3. Finds the daemon that owns the workspace, or starts one. `--remote-key` only applies when the relay starts a new daemon; a running daemon keeps the model mode it started with.
4. Checks the daemon before relaying a byte: the discovery files under `/tmp/amira-<uid>-workspaces/` and the socket under `$XDG_RUNTIME_DIR/amira/` (or the `/tmp` fallback) must be private to the user (directories `0700`, files `0600`, owned by the user, no symbolic links), and the connected socket peer must be the recorded daemon process (same user ID, PID and process start time).
5. Copies bytes both ways until either side closes. Closing the relay detaches; it never stops the daemon or its work.

The relay's stdout carries only protocol frames. If it cannot attach, it writes one `reject` frame and exits; details go to private logs, never to stdout.

Other commands on the host:

- `amira-server list` prints `{"v":1,"workspaces":[...]}` on one line: the workspace path, `protocol`, server `release` and `daemonEpoch` of each live daemon owned by the user.
- `amira-server stop --cwd <workspace>` stops a daemon and all of its work. It is not a detach.

Saved conversations inside a workspace are listed with the `sessions.list` operation after attaching.

## Framing

- Each frame is one JSON object encoded as UTF-8, followed by `\n` (a preceding `\r` is tolerated). There is no byte-order mark and no other separator.
- A line may hold at most `lineBytes` = 262,144 bytes before the newline. A larger frame (for example a prompt with images or a big snapshot) is sent as `chunk` frames: serialize the frame, split the bytes into 131,072-byte parts, and send each part base64-encoded in order with the same fresh `transferId`, its `index`, `total` parts, the full byte length `bytes` and the hex SHA-256 of the full bytes. The receiver reassembles, checks the hash and handles the inner frame. A chunk never contains a chunk.
- Logical limits: a frame is at most `logicalBytes` = 67,108,864 bytes, JSON nesting at most 64 levels, at most 1,000,000 JSON values, numbers must be finite. At most 4 chunked transfers may be in flight and 128 requests may be pending in each direction.
- Client frames are validated **strictly**. An unknown field, a missing required field, a wrong type or a value outside the schema closes the connection. After the handshake the server does not send an error first: it simply closes. Never send fields the schema does not list.

## Handshake

The client sends `hello` first and must wait for `welcome` (or `reject`) before anything else.

| `hello` field | Meaning |
| --- | --- |
| `v` | Always `1`. |
| `clientId` | Your attachment identity, 1 to 128 characters of `[A-Za-z0-9_.:-]`. Pick a random value per attachment and reuse it when resuming. |
| `workspace` | Absolute workspace path on the host. |
| `release` | Your client's own `version`, `buildId` and `target`. The server does not interpret it; use it to identify your client (for example `"buildId": "my-gui"`). |
| `limits` | Exactly `{ "lineBytes": 262144, "logicalBytes": 67108864 }`. |
| `capabilities` | Optional behaviors you understand (see below). Unknown strings are ignored. |
| `resume` | Optional: `daemonEpoch`, `after` (last applied event `seq`) and `controllerToken` from an earlier `welcome`, to reconnect. |
| `snapshot` | Optional: `true` asks for a `reset` snapshot even when resuming. |

`welcome` returns the server `release`, the canonical `workspace` and its `workspaceId`, the `daemonEpoch`, `controllerGeneration`, `sessionGeneration`, the `controllerToken` for reconnecting (keep it secret), the same `limits` and the server `capabilities`:

| Capability | Meaning |
| --- | --- |
| `frontend.v1` | The control-channel operations in this document. |
| `replay`, `controller`, `mutation.ledger` | Event replay on resume, the controller lease and retried-request deduplication. |
| `jobs`, `conversations` | The `jobs.*` and `conversations.*` operations. |
| `files`, `images` | The internal files channel. |
| `model.remote-key` / `model.proxy` | Where the daemon makes model calls (see [Current limits](#current-limits)). |
| `context-window-source.provider` | Also a client capability: see [Versioning](#versioning-and-compatibility). |

There is no version negotiation. A `hello` with a different `v` is refused with `reject` code `incompatible_protocol`, and so is an attachment to a running daemon that speaks another protocol version. A client must check that `welcome.v` is `1` and close otherwise.

`reject` codes: `controller_busy`, `incompatible_protocol`, `invalid_frame`, `invalid_workspace`, `permission_denied` (for example expired reconnect credentials), `startup_failed`, `limit_exceeded`, `disconnected`, `unsupported_operation`, `operation_failed`. The connection closes after a `reject`.

## Requests and responses

A `request` carries `channel` (`"control"`), a client-chosen `id`, `op`, `params`, and the `daemonEpoch`, `controllerGeneration` and `sessionGeneration` the request was made for. Use the values from `welcome`; take a new `sessionGeneration` from each snapshot (`frontend.sessionGeneration`) after the session changes. Always send `daemonEpoch`: a request without it, or for another epoch, fails with `outcome_unknown`. Request ids are 1 to 128 characters of `[A-Za-z0-9_.:-]` and must never repeat on one connection. Mutation ids must also be unique per `clientId` for the whole `daemonEpoch`, across reconnects: the daemon keys every mutation by `clientId`, `daemonEpoch` and `id` over all connections and never frees an id. Use a UUID, or a counter that persists across reconnects; never restart a counter at `"1"` after resuming with the same `clientId`. A reused id returns the earlier retained outcome (same params), fails with `operation_conflict` (different params) or fails with `operation_expired` (after the 10-minute retention), and the new request never runs.

The server answers each request with exactly one `response` carrying the same `id` and `op`: either `"ok": true` with `result`, or `"ok": false` with `error: { code, message }`. Responses can arrive in any order and between events. `x-operations` in the schema maps each operation to its params and result definitions.

`cancel` (same `channel`, `id`, `controllerGeneration` and `sessionGeneration`) aborts a pending request. A cancelled request may get no response; ignore a late one.

Read operations fail with `stale_session` when `sessionGeneration` is not current. Mutations are recorded per `clientId` and `id`: when a connection drops before the response arrives, reconnect with `resume` and send the same request again with the **same** `id` and original `daemonEpoch`; the daemon returns the original outcome instead of running it twice.

| Area | Operations |
| --- | --- |
| State | `state.read`, `transcript.read`, `status.read`, `models.list`, `permissions.cycle`, `model.set`, `thinking.set`, `fastMode.set` |
| Turns | `turn.prompt`, `turn.steer`, `turn.abort` |
| Commands | `command.run`, `skill.run`, `input.run`, `commands.describe`, `commands.complete` |
| Sessions | `sessions.list`, `sessions.read`, `session.resume`, `session.clear`, `session.fork`, `session.rewind`, `session.planRewind` |
| Sub-agents and conversations | `conversations.list`, `conversations.history`, `conversations.focus`, `conversations.unfocus`, `conversations.control`, `conversation.send`, `conversation.stop` |
| Background jobs | `jobs.list`, `jobs.output`, `jobs.stop`, `jobs.wait` |
| UI requests and forms | `ui.respond`, `ui.cancel`, `form.open`, `form.evaluate`, `form.action`, `form.submit`, `form.cancel` |

`turn.prompt` and `turn.steer` take a string or a user message whose content holds text and image blocks. `command.run` runs a slash command line such as `/clear`; `commands.describe` and `commands.complete` provide the command list and completions.

### Errors

`error.code` is stable and machine-readable; `message` is display text and may change. Codes a client should handle:

| Code | Meaning |
| --- | --- |
| `agent_busy` | The agent cannot accept this now, for example while a turn or compaction is running. |
| `stale_session` | `sessionGeneration` is no longer current. Refresh from the latest snapshot. |
| `stale_operation` | The target (a UI request, form or conversation) is no longer pending or current. |
| `stale_controller` | `controllerGeneration` is no longer current; this attachment was replaced. |
| `outcome_unknown` | The request belongs to another `daemonEpoch`; the daemon restarted. Resynchronize. |
| `operation_conflict` | The same `id` was reused with different params. |
| `operation_expired` | The original outcome of a retried mutation is no longer retained. |
| `unsupported_operation` | The operation is not available here. |
| `cancelled`, `disconnected` | The request was cancelled, or the workspace detached it. |
| `limit_exceeded`, `invalid_frame` | A limit or validation failure. |
| `operation_failed` | Any other failure. Details stay on the host. |

## Events

The server streams `event` frames. `seq` counts events within one `daemonEpoch` and increases by exactly one; ignore an event whose `seq` you have already applied, and treat a gap as a lost connection. `replay: true` marks events re-sent on resume.

`reset` carries a complete `WorkspaceSnapshot` and replaces all client state; the next event has `seq` greater than `reset.seq`. A fresh attachment always starts with a `reset` (`reason: "fresh"`). On resume the server either replays the events after `resume.after`, or sends a `reset` when the epoch changed (`epoch_changed`), the cursor fell out of replay retention (`cursor_expired`, 32 MiB or 50,000 events), the cursor is ahead (`future_cursor`), or capture failed (`capture_failed`).

An event `payload` is either a **core event** (it has `type`, for example `turn.start`, `message.delta`, `tool.execute.end`, `ui.request`; its own `seq` counts per session and is unrelated to the frame's `seq`) or a **workspace notification** (it has `kind`):

| `kind` | Meaning |
| --- | --- |
| `snapshot` | The full frontend snapshot (state and transcript) after each change. |
| `error` | The display state is unavailable (`invalid_snapshot`). |
| `semantic` | Status line items, models, sub-agents and groups. |
| `jobs` | Background job list. |
| `inputQueue`, `steering`, `noticeInbox`, `noticeRetry`, `hold` | Queued input and notice state per session. |
| `effect` | A frontend action requested by a command: `detach`, `rewind`, `unfocus`, `view` or `focus`. |
| `startup` | Startup events of the workspace. |

The client may send `ack` with `id` set to the `daemonEpoch` and `seq` set to the last applied event. It must not exceed the last received `seq` or go backwards.

The server sends `ping` with `id: "heartbeat"` every 15 seconds; answer each with a `pong` carrying the same `id`, or the server closes the connection after 45 to 60 seconds without one. The client may also ping; the server answers with `pong`.

## UI requests

When the agent needs an answer (a tool approval, a question, a form, extension settings), the server emits a `ui.request` core event; pending requests are also listed in every snapshot's `pendingRequests`. Answer with `ui.respond { requestId, value }`, or dismiss with `ui.cancel`:

| `kind` | `value` |
| --- | --- |
| `select` | One of `options`, or `{ "option", "key" }` when the option's section defines keys. |
| `confirm` | `true` or `false`; `"always"` when `always` is set; `{ "other": text }` when `other` is set. |
| `input` | A string. |
| `diff-review` | One of `options`. |
| `ask` | One answer per question: `{ "selected": [labels], "other"?: text }`. |
| `extension-settings` | `{ "values": {...}, "scope": "user" \| "project" }`. |
| `form` | Not via `ui.respond`. Use `form.open` to get an editor and revision, `form.evaluate` while editing, `form.action` for action fields, then `form.submit` or `form.cancel`. |

The acknowledgement is `accepted`, `cancelled`, `settled` (already answered), `invalid` or `disconnected`. A `ui.resolved` event tells every frontend that a request is closed. Since only the controller is attached, it is the one frontend that answers.

## Versioning and compatibility

Within protocol version 1:

- The server may add new operations, events, notification kinds, optional fields and enum values only behind a capability. It sends them only to clients that listed the capability in `hello.capabilities`. Example: the context-window source value `"provider"` (in `status.read` and the semantic status) is sent only to clients that advertised `context-window-source.provider`; other clients get the field omitted. The schema notes each such value in its `description`.
- New server capabilities appear in `welcome.capabilities`; a client uses an optional operation only after seeing its capability.
- Client frames are validated strictly. A client must never send a field or value that is not in the schema of the server version it talks to, even an optional one, unless the server advertised the capability that introduces it.
- Breaking changes (removing or renaming anything, changing a type, making an optional field required, changing ordering or correlation rules) require a new protocol version and a new schema file, `frontend-v2.schema.json`. A daemon refuses clients of another version with `incompatible_protocol`; an old client then tells the user that the client or the server must be updated. There is no downgrade mode.
- A client built for version 1 keeps working against newer version-1 servers: it never sees fields it did not ask for, and unknown capabilities in `welcome` can be ignored.

Generated code should still tolerate unknown properties on objects it receives, for robustness, but the server will not send them to a version-1 client that did not advertise them.

### Using the schema

The schema is one bundle: every type is a named entry under `$defs`, referenced with local `$ref`s only, so code generators (for example for C# with `System.Text.Json`) need no cross-file resolution and produce stable type names. `ClientFrame` and `ServerFrame` are the roots. Unions name their tag in a non-validating `x-discriminator` keyword (`kind`, `type`, `op`, `role`, `status`, `state` or `action`); `EventPayload` is told apart by whether it has `type` (core event) or `kind`. `x-operations` maps each operation name to its `params` and `result` definitions. Integers are non-negative safe integers (at most 2^53 - 1). String lengths and patterns follow JSON Schema rules.

## Example exchange

A complete exchange against a daemon with a mock model, as one JSON object per line on the wire (pretty-printed here; some events are left out, so `seq` values skip). Amira's tests check every frame below against the schema.

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

After `turn.end` the server keeps streaming: the status returns to `idle` and a final `snapshot` notification carries the transcript with the assistant reply.
