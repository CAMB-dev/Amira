import "../server/offline.ts"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { SessionStore } from "@amira/core"
import { type InteractiveOptions, runInteractive } from "@amira/tui"
import { FakeTerminal } from "@amira/tui-kit"
import { noProbe } from "../../../tui/test/app-harness.ts"
import { VirtualScreen } from "../../../tui-kit/test/screen.ts"
import { attachRemoteUi } from "../../src/remote/attach-ui.ts"
import type { RemoteAttachContext } from "../../src/remote/command.ts"
import { loadRemoteLocalSettings } from "../../src/remote/local-settings.ts"
import type { RemoteRelease } from "../../src/remote/protocol.ts"
import type { SshSession } from "../../src/remote/ssh.ts"
import { workspaceAttachments } from "../../src/server/attachments.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import { loopback, welcome } from "./loopback.ts"

// Generous: mock replies are delayed on purpose and the full suite runs files in parallel.
async function until(what: string, check: () => boolean, ms = 20_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

/**
 * Two real remote TUIs on one in-memory workspace daemon with roles on (as on Linux). Each
 * relay is a loopback byte stream, so this runs on every OS without SSH or processes.
 */
async function sharedWorkspace(steps: MockStep[] = [{ text: "controller reply" }]) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-viewer-ui-"))
  const home = mkdtempSync(path.join(os.tmpdir(), "amira-viewer-home-"))
  let time = 10_000
  const runtime = await createWorkspaceRuntime({
    cwd,
    model: "mock/test",
    autoTitle: false,
    store: SessionStore.create({ cwd, dir: path.join(home, "sessions") }),
    ai: createAi({
      dialects: [createMockDialect(steps)],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }),
    builtins: async () => [],
  })
  const authority = workspaceAttachments(runtime, { heartbeatMs: 0, roles: true, now: () => time })
  const sessions: SshSession[] = []
  const attached: Promise<number>[] = []
  const uis: { close(): Promise<void> }[] = []
  async function attach(release: RemoteRelease) {
    const mounted = Promise.withResolvers<{
      options: InteractiveOptions
      terminal: FakeTerminal
      live(): string
      close(): Promise<void>
    }>()
    const context: RemoteAttachContext = {
      host: "fixture-host",
      workspace: cwd,
      installedRelease: release,
      modelMode: "remote-key",
      async open() {
        const io = loopback()
        const server = authority.connect(io.server, { release: welcome.release, workspace: cwd })
        const exited = server.closed.then(() => 0)
        const session: SshSession = {
          ...io.client,
          end: async () => io.client.close(),
          exited,
          stderr: () => "",
        }
        sessions.push(session)
        return session
      },
      validateWelcome: () => ({ replacementPending: false }),
      connect: () => Promise.reject(new Error("unused")),
    }
    attached.push(
      attachRemoteUi(context, {
        local: loadRemoteLocalSettings(home),
        async interactive(options) {
          const terminal = new FakeTerminal(110, 28)
          const screen = new VirtualScreen(110, 28)
          const write = terminal.write.bind(terminal)
          terminal.write = (text) => {
            write(text)
            screen.write(text)
          }
          const ready = Promise.withResolvers<void>()
          let detach = () => {}
          const exited = runInteractive({
            ...options,
            terminal,
            setup: noProbe,
            env: {},
            settings: { margin: 0, marginRows: 0 },
            onReady: () => ready.resolve(),
            subscribeFrontendEffects(listener) {
              detach = () => listener({ kind: "detach" })
              return options.subscribeFrontendEffects!(listener)
            },
          })
          await ready.promise
          const done = Promise.withResolvers<void>()
          const ui = {
            options,
            terminal,
            live: () => screen.lines.join("\n"),
            async close() {
              detach()
              await exited
              done.resolve()
            },
          }
          uis.push(ui)
          mounted.resolve(ui)
          await done.promise
          return 0
        },
      }),
    )
    return mounted.promise
  }
  return {
    runtime,
    attach,
    advance(ms: number) {
      time += ms
    },
    async dispose() {
      await Promise.allSettled(uis.map((ui) => ui.close()))
      for (const session of sessions) session.close()
      await Promise.allSettled(attached)
      await runtime.stop()
      for (const dir of [cwd, home])
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    },
  }
}

const messages = (runtime: { workspaceSnapshot(): unknown }) =>
  (runtime.workspaceSnapshot() as { frontend: { transcript: { messages: unknown[] } } }).frontend.transcript
    .messages.length

test("a second TUI watches with a banner, refuses input, takes control, and the first one watches", async () => {
  const f = await sharedWorkspace()
  const gui = { version: "0.2.0", buildId: "amira-gui", target: "win32-x64" }
  const tui = { version: "0.1.0", buildId: "amira-tui", target: "linux-x64" }
  try {
    const first = await f.attach(tui)
    const second = await f.attach(gui)
    await until("viewer banner", () => second.live().includes("Read-only viewer"))
    expect(second.live()).toContain("amira-tui 0.1.0 (linux-x64) controls this workspace")
    expect(second.live()).toContain("/take to take control")
    expect(second.live()).toContain("Remote viewer")
    await until("viewer count", () => first.live().includes("1 viewer"))
    expect(first.live()).not.toContain("Read-only viewer")

    // Typing is refused locally: nothing is sent and the draft stays.
    second.terminal.send("watch only\r")
    await until("viewer refusal", () => second.live().includes("nothing was sent"))
    expect(second.live()).toContain("watch only")
    expect(messages(f.runtime)).toBe(0)
    second.terminal.send("\x15")

    // Inside the one-second controller change rule the take is refused in plain words.
    second.terminal.send("/take\r")
    await until("refused take", () => second.live().includes("Could not take control"))
    await until("viewer again", () => second.options.frontend!.attachment?.role === "viewer")
    expect(second.options.frontend!.connection).toBe("connected")
    expect(second.options.frontend!.connectionIssue).toBeUndefined()

    f.advance(1_000)
    second.terminal.send("/take\r")
    await until("taken", () => second.live().includes("You now control this workspace"))
    expect(second.options.frontend!.attachment?.role).toBe("controller")
    await until("old holder watches", () => first.options.frontend!.attachment?.role === "viewer")
    await until("takeover banner", () =>
      first.live().includes("Control was taken by amira-gui 0.2.0 (win32-x64)."),
    )
    expect(first.live()).toContain("Another client took control of this workspace.")
    expect(first.options.frontend!.connectionIssue).toBeUndefined()
    await until("new controller counts the old one", () => second.live().includes("1 viewer"))

    second.terminal.send("from the new controller\r")
    await until("controller turn", () => first.live().includes("controller reply"))
    expect(messages(f.runtime)).toBe(2)

    // The viewer opens a stored session from its picker with reads only.
    first.terminal.send("/sessions\r")
    await until("session picker", () => first.live().includes("Stored sessions (read-only)"))
    await until("picker row", () => first.live().includes("from the new controller"))
    first.terminal.send("\r")
    await until(
      "opened session",
      () => first.live().includes("Session ") && first.live().includes("controller reply"),
    )
    expect(first.options.frontend!.attachment?.role).toBe("viewer")
    expect(messages(f.runtime)).toBe(2)
  } finally {
    await f.dispose()
  }
}, 30_000)

test("Esc on a viewer leaves the controller's turn running and offers /take instead of stop", async () => {
  const f = await sharedWorkspace([{ text: "slow controller reply", delayMs: 1500 }])
  try {
    const first = await f.attach({ version: "0.1.0", buildId: "amira-tui", target: "linux-x64" })
    const second = await f.attach({ version: "0.2.0", buildId: "amira-gui", target: "win32-x64" })
    await until("viewer banner", () => second.live().includes("Read-only viewer"))
    first.terminal.send("a long turn\r")
    await until("viewer sees the turn", () => second.live().includes("/take read-only, take control"))
    expect(second.live()).not.toMatch(/Esc (stop|interrupt)/)
    second.terminal.send("\x1b")
    await until("read-only stop notice", () => second.live().includes("cannot stop the turn"))
    await until("the turn finishes", () => second.live().includes("slow controller reply"))
    expect(first.live()).toContain("slow controller reply")
    expect(second.live()).not.toContain("Interrupted")
    expect(first.live()).not.toContain("Interrupted")
  } finally {
    await f.dispose()
  }
}, 30_000)
