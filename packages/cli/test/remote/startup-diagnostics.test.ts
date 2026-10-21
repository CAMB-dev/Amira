import "../server/offline.ts"
import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { runInteractive } from "@amira/tui"
import { FakeTerminal } from "@amira/tui-kit"
import { noProbe } from "../../../tui/test/app-harness.ts"
import { VirtualScreen } from "../../../tui-kit/test/screen.ts"
import { attachRemoteUi } from "../../src/remote/attach-ui.ts"
import type { RemoteAttachContext } from "../../src/remote/command.ts"
import { loadRemoteLocalSettings } from "../../src/remote/local-settings.ts"
import { workspaceAttachments } from "../../src/server/attachments.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import { until } from "./agent-port-fixture.ts"
import { loopback, welcome } from "./loopback.ts"

test("startup diagnostics reach the initial codec-backed TUI mount and are displayed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "amira-remote-startup-"))
  const home = path.join(root, "local")
  const cwd = path.join(root, "remote-workspace")
  await Promise.all([mkdir(home), mkdir(cwd)])
  const runtime = await createWorkspaceRuntime({
    cwd,
    model: "mock/test",
    autoTitle: false,
    builtins: async () => [],
    warnings: ["Startup diagnostic sentinel"],
    ai: createAi({
      dialects: [createMockDialect([{ text: "unused" }])],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      env: {},
    }),
  })
  const authority = workspaceAttachments(runtime, { heartbeatMs: 0 })
  const context: RemoteAttachContext = {
    host: "fixture",
    workspace: cwd,
    installedRelease: welcome.release,
    modelMode: "remote-key",
    async open() {
      const io = loopback(37)
      const connection = authority.connect(io.server, { workspace: cwd, release: welcome.release })
      return {
        ...io.client,
        end: async () => io.client.close(),
        exited: connection.closed.then(() => 0),
        stderr: () => "",
      }
    },
    validateWelcome: () => ({ replacementPending: false }),
    async connect() {
      throw new Error("unused")
    },
  }
  try {
    await attachRemoteUi(context, {
      local: loadRemoteLocalSettings(home),
      async interactive(options) {
        expect(
          options.startupEvents?.some(
            (event) =>
              event.type === "extension.error" && event.data.error.includes("Startup diagnostic sentinel"),
          ),
        ).toBe(true)
        const terminal = new FakeTerminal(110, 30)
        const screen = new VirtualScreen(110, 30)
        const write = terminal.write.bind(terminal)
        terminal.write = (text) => {
          write(text)
          screen.write(text)
        }
        let detach = () => {}
        const exited = runInteractive({
          ...options,
          terminal,
          setup: noProbe,
          env: {},
          subscribeFrontendEffects(listener) {
            detach = () => listener({ kind: "detach" })
            return options.subscribeFrontendEffects!(listener)
          },
        })
        try {
          await until(() => screen.lines.join("\n").includes("Startup diagnostic sentinel"))
        } finally {
          detach()
          await exited
        }
        return 0
      },
    })
  } finally {
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  }
})
