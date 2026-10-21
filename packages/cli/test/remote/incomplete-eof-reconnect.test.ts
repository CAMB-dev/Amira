import "../server/offline.ts"
import { expect, test } from "bun:test"
import { SPAWN_TEST_TIMEOUT_MS, waitForSpawnCondition } from "../../../../scripts/spawn-test.ts"
import { attachRemoteUi } from "../../src/remote/attach-ui.ts"
import { runRemoteCommand } from "../../src/remote/command.ts"
import { ATTACH_REMOTE_KEY_SCRIPT } from "../../src/remote/deployment-scripts.ts"
import { loadRemoteLocalSettings } from "../../src/remote/local-settings.ts"
import { deploymentFixture, shellWords } from "./deployment-fixture.ts"

test(
  "a 17-byte welcome EOF automatically reconnects through actual attach to a healthy next transport",
  async () => {
    const fixture = await deploymentFixture()
    const attaches = () =>
      fixture.calls.filter((argv) => shellWords(argv.at(-1)!)[2] === ATTACH_REMOTE_KEY_SCRIPT).length
    try {
      await fixture.configure({ frontend: true })
      await runRemoteCommand(["attach", "fixture-host", "--accept-install", "--remote-key"], {
        ...fixture.dependencies,
        attach: (context) =>
          attachRemoteUi(context, {
            local: loadRemoteLocalSettings(fixture.local),
            async interactive(options) {
              const before = attaches()
              expect(options.frontend!.connection).toBe("connected")
              await fixture.configure({ truncateWelcome: true })
              fixture.children.at(-1)!.close()
              await waitForSpawnCondition(
                "truncated welcome reconnect issue",
                () =>
                  attaches() === before + 1 &&
                  options.frontend!.connection === "disconnected" &&
                  options.frontend!.connectionIssue !== undefined,
              )
              expect(options.frontend!.connectionIssue).toMatchObject({
                code: "transport",
                retryable: true,
              })
              expect(attaches() - before).toBe(1)
              await fixture.configure({ truncateWelcome: false })
              await waitForSpawnCondition(
                "automatic healthy attachment after partial welcome EOF",
                () => options.frontend!.connection === "connected" && !options.frontend!.connectionIssue,
              )
              expect(attaches() - before).toBe(2)
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
