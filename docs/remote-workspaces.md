# Remote workspaces

[简体中文](zh/remote-workspaces.md) · [日本語](ja/remote-workspaces.md) · [Documentation](../README.md)

Remote workspaces run the agent, tools and sessions on a Linux host while the fullscreen terminal UI runs on your computer. Connect over SSH; no filesystem mount or project synchronization is involved. By default, model requests pass through your local provider connection and provider keys stay local.

## Requirements

- System OpenSSH (`ssh`) on your computer, with working authentication and host-key verification. Use an SSH config alias for identity files, ports and ProxyJump; the remote command accepts an alias or `[user@]hostname`, not SSH options or a URL.
- A Linux host with glibc 2.28 or newer, on x64 with SSE4.2 or ARM64. musl/Alpine and other remote operating systems are not supported.
- An existing remote workspace directory, a writable remote home, and standard Linux shell utilities, including `getconf`, `sha256sum` and GNU-compatible `stat` and `mv`. Installation needs no sudo or remote Bun installation.
- A client with a trusted server release key and matching signed server artifacts. For release clients, missing artifacts are downloaded and cached **on your computer**. The remote host does not download the server binary.
- An interactive terminal for attachment; `TERM=dumb`, print mode and legacy RPC are not remote frontends.

Amira uses SSH stdio without a PTY or SSH agent forwarding. Establish authentication and verify the host key through your normal SSH setup first; Amira does not bypass these checks.

## Add and attach

```sh
amira remote add devbox --name project --cwd /home/dev/project
amira remote attach project
```

`add` probes the host, installs the server and saves a local target; it does not open the UI. Review the disclosed SSH user, install location, server version/build and model mode before approving installation and future automatic binary updates. `attach` can also set up a host directly:

```sh
amira remote attach devbox --cwd /home/dev/project
```

`--cwd` must be an absolute Linux path, not `~` or a local path. Without it, an existing target uses its saved workspace; a new host uses its remote home. Attachment resolves the canonical workspace on the remote host. A supplied workspace becomes the saved default for that target. Target names start with a letter or number and contain only letters, numbers, dots, underscores or hyphens (up to 128 characters).

For noninteractive installation consent, use `--accept-install` (`--yes` is an alias). This authorizes installation and automatic updates, not provider-binding approval. `attach` still needs a terminal.

```sh
amira remote add devbox --name project --cwd /home/dev/project --accept-install
```

For offline artifacts, supply a local bundle directory on each invocation that needs it:

```sh
amira remote attach project --bundle /path/to/signed-server-bundle
```

The directory contains `server-manifest.json`, its base64 Ed25519 signature in `server-manifest.json.sig`, and the applicable raw executable: `amira-server-bun-linux-x64-baseline` or `amira-server-bun-linux-arm64`. The manifest must match the client's version and explicit build ID. The bundle cannot supply its own trust key. Development checkouts require a signed local bundle and an explicit developmental `AMIRA_SERVER_BUILD_ID`; the package version alone is not enough.

Run `amira remote --help` for remote options. Ordinary startup flags such as `--model`, `--resume`, `-p` and `--extension` are not accepted by `remote add` or `remote attach`. Only `--name` is specific to `add`; the other documented remote options apply to both. There are no `remote list`, `remote remove` or `remote stop` client commands.

## Models and credentials

### Default: local provider connection

Remote settings choose the models, including sub-agent, title and compaction models. Configure those provider/model references on the remote host using [Providers](providers.md) and [Settings](settings.md); configure the corresponding provider credentials on your computer. A binding needs the same provider ID and dialect locally. Amira does not replace the remote model list with your local one or offer a general provider-alias mapping.

Before the UI opens, Amira asks whether a remote provider may use a specific local provider account and endpoint. Check the expected remote endpoint, local endpoint and billing account. This approval is separate from remote tool approvals: it permits model requests against that local account, not access to the key itself. The remote endpoint does not choose where the local key is sent.

Approval receipts stay local under `remote/bindings` in the local Amira home. They contain hashes rather than provider keys, headers or credential-bearing URLs, and are scoped to the SSH target/workspace and binding identity. Changing credentials, endpoints or the remote provider identity invalidates the matching approval. A missing or declined binding leaves that model unavailable; configure and approve it locally, then reattach. There is no automatic fallback to remote credentials.

Prompts, tool results and images needed for inference pass through local memory to the provider. Keeping keys local does not mean keeping workspace content off your computer or away from the provider.

### Explicit remote credentials

```sh
amira remote add devbox --name remote-models --cwd /home/dev/project --remote-key
amira remote attach remote-models
```

`--remote-key` uses provider credentials configured on the remote host and makes provider requests there. It never copies your local provider keys. The selected mode is saved with the target's consent: later attachments to that target retain remote-key mode even without the flag. Omitting the flag does not reset it to local proxy mode; there is currently no `--local-proxy` switch.

A live daemon keeps the model mode it started with. Changing target consent does not change that running process. Stop it explicitly, after checking its work, before starting the workspace in another mode; an incompatible attachment is refused rather than silently switching credentials.

## Which computer owns what?

| Remote host | Your computer |
| --- | --- |
| Agent, built-in tools, shell commands, jobs, sub-agents and workspace files | Fullscreen rendering, clipboard, external editor and terminal interactions |
| Agent settings, provider/model definitions, permissions, trust, instructions, skills and MCP configuration | User-level theme, keybindings and `tui` settings; local project settings/themes are not loaded |
| Saved conversations and session controls such as `/resume`, `/clear`, forks and rewinds | SSH target records, artifact cache and provider-binding receipts under the local Amira home's `remote` directory |
| Provider credentials only in explicit remote-key mode | Provider credentials and HTTP requests in default local-proxy mode; input history stays in memory |

Normal [settings precedence](settings.md) applies on the remote host. Local configuration is not synchronized or forwarded wholesale. `AMIRA_HOME` selects the local Amira home; the SSH installer uses the remote user's `$HOME/.amira/remote`, with launcher `$HOME/.amira/remote/bin/amira-server`.

Only bundled executable extensions run in remote mode. Installed or explicitly configured executable extensions are skipped with notices; their custom tools, commands and views do not gain remote support. Trusted package skill data can still be discovered remotely. The bundled profile includes tools, skills, MCP, web, status and sub-agents, but not `/provider` or `/ext` administration. Manage remote provider settings and packages outside the attached UI. Local installed extensions do not run in the remote frontend either. See [Extensions](extensions.md).

## Files, images and links

- `@` completion lists **remote** files, including the appropriate remote scope when focusing a sub-agent/worktree. It does not browse your local checkout.
- Selecting a remote image in `@` reads it from the remote host. Pasted/dropped local image paths and clipboard images are read locally and uploaded as bytes; relative local paths use the directory where you launched the client, not the remote workspace. No local pathname is handed to the server as a file to open.
- The normal supported image formats and **5 MB total per message** limit apply. The selected model must accept images. See [Images](usage.md#images).
- Remote file paths are displayed as text, not clickable local file/editor links. Only HTTP(S) targets are enabled as terminal hyperlinks in remote mode.

There is no file synchronization, port-forwarding feature, remote editor bridge, container launcher or WSL launcher. Opening a local editor edits the local draft, not the remote project files.

## Detach, stop and reconnect

One daemon owns each remote user + canonical workspace, with one active main conversation and one controller. There is no viewer mode or concurrent-controller support. Another client is refused while the controller is held. After a connection closes, the controller is reserved for up to 30 seconds; a fresh attachment may need to wait. Exceeding that detached grace invalidates the old reconnect credentials, even though their absolute maximum lifetime is 24 hours. After either deadline, quit and run `amira remote attach` again for a fresh attachment; `/reconnect` cannot repair an expired controller lease.

- **Detach:** `/quit` exits the local UI and disconnects. It does not stop the daemon, running tools, background jobs, sub-agents or pending remote approvals/questions. Closing the terminal also removes the local model broker.
- **Stop a turn:** Esc stops the current turn (or cancels a running slash command first). It does not stop every background job or sub-agent. Use `/tasks` and `/agents` controls for those.
- **Stop the workspace:** run the following **on the remote host**, as the same SSH user. This deliberately stops the daemon and its active work; it is not a detach command.

```sh
"$HOME/.amira/remote/bin/amira-server" stop --cwd /home/dev/project
```

A temporary SSH interruption triggers automatic reconnect. Setup is probed and signed artifacts are checked again on each new connection. Authentication/host-key failures, changed remote identity/platform, rejected artifacts, installation errors and incompatible daemons stop automatic retries and show a recovery notice. Fix the cause, then use local `/reconnect`. If approval must change, detach and run `remote add` again to review it; `/reconnect` does not grant consent or bypass verification.

In local-proxy mode, remote tools/jobs can continue without the client, but the next model request waits for an admitted local broker. The default wait is 10 minutes; expiry ends the affected turn as a network failure, not as a user abort. An already attempted provider call can only resume the same retained call in the same local process, within bounded retention. It is never automatically reissued as a new paid request after losing that call. Quitting/crashing the client loses that broker memory; a new attachment cannot recover the old provider stream. Remote-key mode does not depend on a local broker.

Reconnect to a live daemon is different from `/resume` (selecting stored conversation history) or daemon restart. Replay is in memory only, bounded by **32 MiB or 50,000 events**, whichever fills first. An expired cursor or new daemon epoch causes snapshot resynchronization, including current in-flight/pending state where it still exists; it does not recover every old transient event. Saved sessions are not an unbounded event journal.

After a daemon crash, host restart or idle exit, a new daemon opens the latest saved conversation for the workspace. It cannot resurrect a running tool, OS process, job, approval dialog or provider stream. Only history already saved is available; reconnect is not crash recovery.

### Timeouts

Set these on the **remote host**, not in the local frontend settings:

```json
{
  "remote": {
    "idleTimeoutMs": 1800000,
    "proxyReconnectTimeoutMs": 600000
  }
}
```

`idleTimeoutMs` defaults to 30 minutes and applies only when detached and truly idle: no running work, pending model calls, approvals/questions or jobs. Pending approvals can therefore keep a daemon alive indefinitely. `proxyReconnectTimeoutMs` defaults to 10 minutes and controls waiting for the local model connection, not controller grace or accepted-call retention. Both accept whole milliseconds from `0` to `2147483647`; `0` disables idle shutdown or waits indefinitely for proxy admission, respectively. Idle timeout is read at daemon startup; a settings reload can update future proxy waits but does not restart already attempted calls or change broker retention.

## Updates

Setup consent includes future matching signed binary updates for that SSH identity/install location and model mode. Each connection verifies the local artifact's signature, size, hash and build identity; upload is checked again remotely before the launcher is replaced atomically. Failed updates preserve the previous working launcher and builds.

Installing a new executable does **not** stop an active daemon. A compatible running build may remain attached with a notice showing installed and running versions/build IDs. Replacement waits until the workspace has no controller/relay connection and no active work or pending requests. Finish the work and detach to let it retire, then attach again. Incompatible running builds refuse attachment; wait for idle retirement or explicitly stop the workspace after reviewing the consequences. Amira never starts a second owner to work around incompatibility.

## Opt-in Linux/SSH maintainer checklist

This is a manual platform acceptance gate, **not** part of automated offline CI and not a claim that Linux or real SSH has been validated. Windows native fixtures and fake SSH do not establish Linux x64/ARM64 support. Run only with explicit maintainer opt-in, disposable hosts/workspaces and isolated client/server accounts/homes. Use a deterministic, maintainer-controlled mock model endpoint with dummy credentials; block live provider access. No real provider spend is needed. The mock endpoint is a test fixture, not a remote CLI flag.

- [ ] Record client/server versions, build IDs, signed artifact hashes, architecture, distro/glibc, CPU and OpenSSH versions. Execute the actual Linux x64 and ARM64 artifacts separately without Bun or Node installed; verify process/stdout workers and shell tools. Cross-compilation alone is not a pass. Check settings-free `--version-json` and `--self-check`.
- [ ] Exercise real OpenSSH aliases, explicit user/port/key configuration and ProxyJump. Confirm unknown/changed host keys and failed authentication do not bypass verification or repeat indefinitely. Confirm no PTY or agent forwarding is requested. Test paths with spaces/quotes, stderr banners and a non-login PATH; stdout must remain valid JSONL.
- [ ] Check glibc/CPU rejection, required utilities, home ownership/permissions, private local-filesystem sockets/metadata/logs, long workspace/socket paths, stale PID/lock recovery and XDG runtime fallback. Verify another user cannot attach, replace metadata or read private logs. Do not relax permissions to force a pass.
- [ ] Install using signed local bundles with remote downloads blocked. Interrupt a real upload; test a full/noexec home, missing checksum tools, corrupted bundle/hash/signature and concurrent setup. Confirm the working launcher survives failures and only verified matching bytes are published.
- [ ] Configure matching remote/local mock model IDs/dialects. Approve the binding locally; test refusal, missing binding, changed endpoint/credential and receipt invalidation. Capture only dummy sentinels and confirm they never appear as credentials in remote protocol inputs, sessions or logs. Test remote-key mode separately without local-key fallback.
- [ ] Run built-in file edits and a long remote shell job; exercise approvals, questions, live forms, sub-agent focus/stop, job output/stop, session switches, status/usage and image steering. Confirm skipped executable extensions are reported and do not execute; verify remote `@` files/images and inert file links.
- [ ] Drop only the SSH relay during work and a pending dialog; reconnect within controller grace. Confirm no duplicate prompts, approvals, form actions/submissions or paid-call starts, and no accidental job/turn abort. Test offline form edits/Save/Cancel and stale replies.
- [ ] Exercise realistic latency, large file lists/image uploads, chatty jobs, output floods and backpressure; check bounded memory, responsive input and cancellation that is not starved. Test truncated frames/EOF and complete malformed frames. Exceed replay retention and confirm snapshot recovery without replaying frontend actions. Test a second controller and reconnect beyond controller grace/token expiry with an actionable fresh-attach recovery.
- [ ] Keep the client alive through a proxy interruption, then test broker retention expiry and lost client-process memory separately. Confirm missing proxy admission ends the turn once as a network failure while unrelated jobs survive; no accepted call is blindly reissued.
- [ ] Compare `/quit`, turn/job/sub-agent stop and explicit workspace stop. Check detached idle shutdown, pending approvals holding the daemon alive, timeout overrides and zero values.
- [ ] Install a new signed build during active work. Check installed/running notices, compatible drain after work and detach, and incompatible refusal without a second daemon or forced stop. Include different versions with the same build ID.
- [ ] Test SSH logout/SIGHUP, session-manager cleanup, daemon kill and host restart on the actual host policy. Confirm only saved history returns, not running processes/dialogs/streams; inspect orphan handling without promising process resurrection.
- [ ] Record each platform/case as pass, fail or not run, with sanitized evidence and remaining gaps. Keep real Linux/SSH results separate from offline codec/mock tests and native Windows packaging results.

Some login managers terminate all user processes at logout. Detaching from SSH cannot override that host policy. If needed, use an administrator-approved user-level supervisor/service or lingering policy and verify it separately; Amira installation itself does not require sudo.
