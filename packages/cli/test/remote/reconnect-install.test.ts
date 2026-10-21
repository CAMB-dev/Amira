import "../server/offline.ts"
import { expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { SPAWN_TEST_TIMEOUT_MS, waitForSpawnCondition } from "../../../../scripts/spawn-test.ts"
import { attachRemoteUi } from "../../src/remote/attach-ui.ts"
import { runRemoteCommand } from "../../src/remote/command.ts"
import { INSTALL_SCRIPT, PROBE_SCRIPT } from "../../src/remote/deployment-scripts.ts"
import { loadRemoteLocalSettings } from "../../src/remote/local-settings.ts"
import { deploymentFixture, deploymentRelease, deploymentTarget, shellWords } from "./deployment-fixture.ts"

test(
  "fullscreen automatic reconnect repairs another client's launcher before admitting a new daemon",
  async () => {
    const fixture = await deploymentFixture()
    try {
      await fixture.configure({ frontend: true })
      let mounted = false
      await runRemoteCommand(["attach", "fixture-host", "--accept-install", "--remote-key"], {
        ...fixture.dependencies,
        attach: (context) =>
          attachRemoteUi(context, {
            local: loadRemoteLocalSettings(fixture.local),
            async interactive(options) {
              mounted = true
              const frontend = options.frontend!
              expect(frontend.connection).toBe("connected")
              const oldRelease = {
                version: "0.0.9",
                buildId: "development-another-client",
                target: deploymentTarget,
              }
              await writeFile(path.join(fixture.remote, "installed.json"), JSON.stringify(oldRelease))
              const initialCalls = fixture.calls.length
              // Close only the current relay. The UI, not this test, must initiate its next open().
              fixture.children.at(-1)!.close()
              await waitForSpawnCondition(
                "verified automatic reconnect",
                () => fixture.calls.length >= initialCalls + 3 && frontend.connection === "connected",
              )
              expect(await fixture.state()).toEqual({ ...deploymentRelease, target: deploymentTarget })
              expect(context.installedRelease).toEqual({ ...deploymentRelease, target: deploymentTarget })
              expect(
                fixture.calls
                  .slice(initialCalls)
                  .map((argv) => shellWords(argv.at(-1)!)[2])
                  .slice(0, 2),
              ).toEqual([PROBE_SCRIPT, INSTALL_SCRIPT])
              return 0
            },
          }),
      })
      expect(mounted).toBe(true)
    } finally {
      await fixture.dispose()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)
