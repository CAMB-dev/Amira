import "../server/offline.ts"
import { expect, test } from "bun:test"
import { type InteractiveOptions, runInteractive } from "@amira/tui"
import { FakeTerminal } from "@amira/tui-kit"
import { SPAWN_TEST_TIMEOUT_MS, waitForSpawnCondition } from "../../../../scripts/spawn-test.ts"
import { noProbe } from "../../../tui/test/app-harness.ts"
import { VirtualScreen } from "../../../tui-kit/test/screen.ts"
import { attachRemoteUi } from "../../src/remote/attach-ui.ts"
import { runRemoteCommand } from "../../src/remote/command.ts"
import { ATTACH_REMOTE_KEY_SCRIPT, PROBE_SCRIPT } from "../../src/remote/deployment-scripts.ts"
import { loadRemoteLocalSettings } from "../../src/remote/local-settings.ts"
import { deploymentFixture, shellWords } from "./deployment-fixture.ts"

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
    live: () => screen.lines.join("\n"),
    async close() {
      detach()
      await exited
    },
  }
}
const count = (fixture: Awaited<ReturnType<typeof deploymentFixture>>, script: string) =>
  fixture.calls.filter((argv) => shellWords(argv.at(-1)!)[2] === script).length

for (const afterWelcome of [false, true])
  test(
    `permanent final relay refusal exposes status and bounded safe stderr and stops retries, afterWelcome=${afterWelcome}`,
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
                  const probes = count(fixture, PROBE_SCRIPT)
                  const relays = count(fixture, ATTACH_REMOTE_KEY_SCRIPT)
                  await fixture.configure({
                    [afterWelcome ? "relayFailureAfterWelcome" : "relayFailure"]:
                      "Remote account policy refuses amira-server attach",
                    relayExitCode: 1,
                    stderrFlood: true,
                  })
                  fixture.children.at(-1)!.close()
                  await waitForSpawnCondition(
                    "failed final relay",
                    () =>
                      count(fixture, ATTACH_REMOTE_KEY_SCRIPT) > relays &&
                      options.frontend!.connectionIssue?.retryable === false,
                  )
                  expect(options.frontend!.connectionIssue?.retryable).toBe(false)
                  expect(options.frontend!.connectionIssue?.message).toContain("status 1")
                  expect(options.frontend!.connectionIssue?.message).toContain(
                    "Remote account policy refuses amira-server attach",
                  )
                  expect(options.frontend!.connectionIssue?.message).not.toContain("\x1b")
                  expect(options.frontend!.connectionIssue?.message).not.toContain("\x07")
                  expect(options.frontend!.connectionIssue!.message.length).toBeLessThanOrEqual(1024)
                  await waitForSpawnCondition("relay failure rendered", () =>
                    ui.live().includes("Remote account policy refuses"),
                  )
                  expect(ui.live()).toContain("/reconnect")
                  await Bun.sleep(2300)
                  expect(count(fixture, PROBE_SCRIPT) - probes).toBe(1)
                  expect(count(fixture, ATTACH_REMOTE_KEY_SCRIPT) - relays).toBe(1)
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

for (const kind of ["malformed", "reject"] as const)
  test(
    `complete ${kind} frames stay terminal and win over a later relay exit`,
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
                  const probes = count(fixture, PROBE_SCRIPT)
                  const relays = count(fixture, ATTACH_REMOTE_KEY_SCRIPT)
                  await fixture.configure(
                    kind === "malformed" ? { relayMalformedFrame: true } : { relayReject: true },
                  )
                  fixture.children.at(-1)!.close()
                  await waitForSpawnCondition(
                    "terminal complete frame classification",
                    () =>
                      options.frontend!.connectionIssue?.code ===
                      (kind === "malformed" ? "invalid_frame" : "permission_denied"),
                  )
                  expect(options.frontend!.connectionIssue?.retryable).toBe(false)
                  expect(options.frontend!.connectionIssue?.message).not.toContain("status 1")
                  await waitForSpawnCondition("terminal protocol cause rendered", () =>
                    ui
                      .live()
                      .includes(
                        kind === "malformed" ? "Malformed JSON" : "Remote protocol policy denies attach",
                      ),
                  )
                  await Bun.sleep(2300)
                  expect(count(fixture, PROBE_SCRIPT) - probes).toBe(1)
                  expect(count(fixture, ATTACH_REMOTE_KEY_SCRIPT) - relays).toBe(1)
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
  "genuine final-relay transport exit still reconnects and intentional detach never launches another relay",
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
                const relays = count(fixture, ATTACH_REMOTE_KEY_SCRIPT)
                await fixture.configure({ relayFailure: "ssh: Connection reset by peer", relayExitCode: 255 })
                fixture.children.at(-1)!.close()
                await waitForSpawnCondition(
                  "transient relay exit classified",
                  () =>
                    options.frontend!.connectionIssue?.message.includes("Connection reset by peer") === true,
                )
                expect(options.frontend!.connectionIssue?.retryable).toBe(true)
                await waitForSpawnCondition("transient relay diagnostics rendered", () =>
                  ui.live().includes("Connection reset by peer"),
                )
                expect(ui.live()).toContain("Retrying automatically")
                await fixture.configure({ relayFailure: undefined })
                await waitForSpawnCondition(
                  "healthy relay after transport exit",
                  () => options.frontend!.connection === "connected" && !options.frontend!.connectionIssue,
                )
                expect(count(fixture, ATTACH_REMOTE_KEY_SCRIPT) - relays).toBe(2)
              } finally {
                await ui.close()
              }
              const launches = fixture.calls.length
              await Bun.sleep(100)
              expect(fixture.calls).toHaveLength(launches)
              expect(options.frontend!.connectionIssue).toBeUndefined()
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
