import "../server/offline.ts"
import { expect, test } from "bun:test"
import { type InteractiveOptions, runInteractive } from "@amira/tui"
import { FakeTerminal } from "@amira/tui-kit"
import { SPAWN_TEST_TIMEOUT_MS, waitForSpawnCondition } from "../../../../scripts/spawn-test.ts"
import { noProbe } from "../../../tui/test/app-harness.ts"
import { VirtualScreen } from "../../../tui-kit/test/screen.ts"
import { attachRemoteUi } from "../../src/remote/attach-ui.ts"
import { runRemoteCommand } from "../../src/remote/command.ts"
import { PROBE_SCRIPT } from "../../src/remote/deployment-scripts.ts"
import { loadRemoteLocalSettings } from "../../src/remote/local-settings.ts"
import {
  deploymentFixture,
  deploymentRelease,
  deploymentTarget,
  shellWords,
  signedBundle,
} from "./deployment-fixture.ts"
import { hello } from "./loopback.ts"

async function mount(options: InteractiveOptions) {
  const terminal = new FakeTerminal(120, 32)
  const screen = new VirtualScreen(120, 32)
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
    onReady: () => ready.resolve(),
    subscribeFrontendEffects(listener) {
      detach = () => listener({ kind: "detach" })
      return options.subscribeFrontendEffects!(listener)
    },
  })
  await ready.promise
  return {
    terminal,
    live: () => screen.lines.join("\n"),
    async close() {
      detach()
      await exited
    },
  }
}

const probes = (fixture: Awaited<ReturnType<typeof deploymentFixture>>) =>
  fixture.calls.filter((argv) => shellWords(argv.at(-1)!)[2] === PROBE_SCRIPT).length

test(
  "an identity change stops actual automatic reconnect and shows cause plus renewed-consent action",
  async () => {
    const fixture = await deploymentFixture()
    try {
      await fixture.configure({ frontend: true })
      await runRemoteCommand(["attach", "fixture-host", "--accept-install", "--remote-key"], {
        ...fixture.dependencies,
        attach: (context) =>
          attachRemoteUi(context, {
            local: loadRemoteLocalSettings(fixture.local),
            async interactive(options) {
              const ui = await mount(options)
              try {
                const before = probes(fixture)
                const originalHome = fixture.config.home
                await fixture.configure({ home: "/different-user-home" })
                fixture.children.at(-1)!.close()
                await waitForSpawnCondition("identity-change probe", () => probes(fixture) > before)
                await Bun.sleep(2300)
                expect(ui.live()).toContain("approve setup again")
                expect(ui.live()).toContain("amira remote add")
                expect(probes(fixture) - before).toBe(1)
                expect(options.frontend!.connection).toBe("disconnected")
                expect(options.frontend!.connectionIssue?.code).toBe("consent_required")
                await fixture.configure({ home: originalHome })
                ui.terminal.send("/reconnect\r")
                await waitForSpawnCondition(
                  "explicit reconnect after restoring approved target",
                  () => options.frontend!.connection === "connected",
                )
                expect(probes(fixture) - before).toBe(2)
                expect(options.frontend!.connectionIssue).toBeUndefined()
              } finally {
                await ui.close()
              }
              return 0
            },
          }),
      })
    } finally {
      await fixture.dispose()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

for (const failure of ["provenance", "platform", "compatibility"] as const) {
  test(
    `${failure} rejection stops actual reconnect with a cause and recovery in the mounted UI`,
    async () => {
      const fixture = await deploymentFixture()
      let corrupt = false
      fixture.dependencies.artifacts = {
        async load() {
          const bundle = signedBundle()
          return corrupt ? { ...bundle, binary: Buffer.from("tampered artifact") } : bundle
        },
      }
      try {
        await fixture.configure({ frontend: true })
        await runRemoteCommand(["attach", "fixture-host", "--accept-install", "--remote-key"], {
          ...fixture.dependencies,
          attach: (context) =>
            attachRemoteUi(context, {
              local: loadRemoteLocalSettings(fixture.local),
              async interactive(options) {
                const ui = await mount(options)
                try {
                  const before = probes(fixture)
                  if (failure === "provenance") corrupt = true
                  if (failure === "platform") await fixture.configure({ arch: "riscv64" })
                  if (failure === "compatibility")
                    await fixture.configure({
                      runningRelease: { ...deploymentRelease, version: "0.0.9", target: deploymentTarget },
                    })
                  fixture.children.at(-1)!.close()
                  await waitForSpawnCondition(
                    "permanent reconnect issue",
                    () => options.frontend!.connectionIssue?.retryable === false,
                  )
                  await waitForSpawnCondition("permanent reconnect issue rendered", () =>
                    ui.live().includes("Automatic reconnect stopped"),
                  )
                  const issue = options.frontend!.connectionIssue!
                  expect(issue.code).toBe(
                    failure === "provenance"
                      ? "provenance_rejected"
                      : failure === "platform"
                        ? "platform_rejected"
                        : "incompatible_daemon",
                  )
                  expect(ui.live()).toContain(
                    failure === "provenance"
                      ? "SHA-256"
                      : failure === "platform"
                        ? "Unsupported remote architecture"
                        : "0.0.9",
                  )
                  expect(ui.live()).toContain(failure === "platform" ? "amira remote add" : "/reconnect")
                  await Bun.sleep(2300)
                  expect(probes(fixture) - before).toBe(1)
                } finally {
                  await ui.close()
                }
                return 0
              },
            }),
        })
      } finally {
        await fixture.dispose()
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
}

test(
  "a transient SSH probe failure is visible and automatically recovers through the real attach path",
  async () => {
    const fixture = await deploymentFixture()
    try {
      await fixture.configure({ frontend: true })
      await runRemoteCommand(["attach", "fixture-host", "--accept-install", "--remote-key"], {
        ...fixture.dependencies,
        attach: (context) =>
          attachRemoteUi(context, {
            local: loadRemoteLocalSettings(fixture.local),
            async interactive(options) {
              const ui = await mount(options)
              try {
                const before = probes(fixture)
                await fixture.configure({ probeFailure: "ssh: Connection reset by peer", probeExitCode: 255 })
                fixture.children.at(-1)!.close()
                await waitForSpawnCondition(
                  "transient reconnect issue",
                  () => options.frontend!.connectionIssue?.retryable === true,
                )
                await waitForSpawnCondition("transient failure rendered", () =>
                  ui.live().includes("Connection reset by peer"),
                )
                expect(ui.live()).toContain("Retrying automatically")
                await fixture.configure({ probeFailure: undefined })
                await waitForSpawnCondition(
                  "automatic transient recovery",
                  () => options.frontend!.connection === "connected" && !options.frontend!.connectionIssue,
                )
                expect(probes(fixture) - before).toBe(2)
              } finally {
                await ui.close()
              }
              return 0
            },
          }),
      })
    } finally {
      await fixture.dispose()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "same-SHA replacement notices show installed and running versions in the fullscreen UI",
  async () => {
    const fixture = await deploymentFixture()
    try {
      await fixture.configure({
        frontend: true,
        runningRelease: { ...deploymentRelease, version: "0.1.0-next.same-sha", target: deploymentTarget },
      })
      await runRemoteCommand(["attach", "fixture-host", "--accept-install", "--remote-key"], {
        ...fixture.dependencies,
        compatibleDaemon: () => true,
        attach: (context) =>
          attachRemoteUi(context, {
            local: loadRemoteLocalSettings(fixture.local),
            async interactive(options) {
              expect(options.notice).toContain("Installed server 0.1.0 (")
              expect(options.notice).toContain("running daemon 0.1.0-next.same-sha (")
              const ui = await mount(options)
              try {
                await waitForSpawnCondition("versioned replacement notice", () =>
                  ui.live().includes("0.1.0-next.same-sha"),
                )
              } finally {
                await ui.close()
              }
              return 0
            },
          }),
      })
    } finally {
      await fixture.dispose()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "same-SHA command attachment notices include both installed and running versions",
  async () => {
    const fixture = await deploymentFixture()
    const notices: string[] = []
    try {
      await fixture.configure({
        runningRelease: { ...deploymentRelease, version: "0.1.0-next.same-sha", target: deploymentTarget },
      })
      await runRemoteCommand(["attach", "fixture-host", "--accept-install", "--remote-key"], {
        ...fixture.dependencies,
        compatibleDaemon: () => true,
        write: (text) => notices.push(text),
        async attach(context) {
          const connection = await context.connect({
            hello: { ...hello, workspace: context.workspace, release: context.installedRelease },
          })
          connection.close()
        },
      })
      expect(notices.join("\n")).toContain("Installed server 0.1.0 (")
      expect(notices.join("\n")).toContain("running daemon 0.1.0-next.same-sha (")
    } finally {
      await fixture.dispose()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)
