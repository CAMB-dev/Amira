import "../server/offline.ts"
import { expect, test } from "bun:test"
import { SPAWN_TEST_TIMEOUT_MS } from "../../../../scripts/spawn-test.ts"
import { parseRemoteCommand, runRemoteCommand } from "../../src/remote/command.ts"
import { REMOTE_PEER_LIMITS } from "../../src/remote/protocol.ts"
import { RemoteTargetStore } from "../../src/remote/targets.ts"
import { deploymentFixture, deploymentRelease, deploymentTarget, shellWords } from "./deployment-fixture.ts"

function hello(workspace: string) {
  return {
    v: 1 as const,
    kind: "hello" as const,
    clientId: "remote-key-client",
    workspace,
    release: { ...deploymentRelease, target: deploymentTarget },
    limits: REMOTE_PEER_LIMITS,
    capabilities: ["replay", "controller"],
  }
}

test("remote-key selection is explicit and duplicate flags are rejected", () => {
  expect(parseRemoteCommand(["attach", "work", "--remote-key"])).toEqual({
    action: "attach",
    target: "work",
    acceptInstall: false,
    modelMode: "remote-key",
  })
  expect(() => parseRemoteCommand(["attach", "work", "--remote-key", "--remote-key"])).toThrow("Repeated")
})

test(
  "remote-key requires fresh consent, persists the selected mode, and reuses it on attach",
  async () => {
    const fixture = await deploymentFixture()
    try {
      await runRemoteCommand(["add", "fixture-host", "--accept-install"], fixture.dependencies)
      const store = new RemoteTargetStore(fixture.local)
      const previous = await store.read("fixture-host")
      await expect(
        runRemoteCommand(["add", "fixture-host", "--remote-key"], fixture.dependencies),
      ).rejects.toThrow("not approved")
      expect(await store.read("fixture-host")).toEqual(previous)
      let disclosure = ""
      await runRemoteCommand(["add", "fixture-host", "--remote-key"], {
        ...fixture.dependencies,
        interactive: true,
        consent: async (text) => {
          disclosure = text
          return true
        },
      })
      expect(disclosure).toContain("Provider credentials configured on the remote host")
      expect(disclosure).not.toContain("Provider keys stay local")
      expect((await store.read("fixture-host"))?.consent.modelMode).toBe("remote-key")
      await runRemoteCommand(["attach", "fixture-host"], {
        ...fixture.dependencies,
        consent: async () => {
          throw new Error("Saved consent must be reused")
        },
        attach: async (context) => {
          expect(context.modelMode).toBe("remote-key")
          const connection = await context.connect({ hello: hello(context.workspace) })
          expect((await connection.ready).capabilities).toContain("model.remote-key")
          connection.close()
          await connection.closed
        },
      })
      expect(shellWords(fixture.calls.at(-1)!.at(-1)!)[2]).toBe('set -eu\nexec "$1" attach --remote-key\n')
    } finally {
      await fixture.dispose()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

for (const mode of ["local-proxy", "remote-key"] as const) {
  test(
    `${mode} refuses a daemon using the other model mode without a restart or fallback`,
    async () => {
      const fixture = await deploymentFixture()
      try {
        const flags = mode === "remote-key" ? ["--remote-key"] : []
        await runRemoteCommand(["add", "fixture-host", "--accept-install", ...flags], fixture.dependencies)
        await fixture.configure({
          capabilities: [mode === "remote-key" ? "model.proxy" : "model.remote-key", "replay"],
        })
        await expect(
          runRemoteCommand(["attach", "fixture-host"], {
            ...fixture.dependencies,
            compatibleDaemon: () => true,
            attach: async (context) => {
              await context.connect({ hello: hello(context.workspace) })
            },
          }),
        ).rejects.toThrow(mode === "remote-key" ? "remote model keys" : "local model proxying")
        expect(fixture.calls).toHaveLength(5) // add probe/upload, attach probe, fresh probe/relay
        expect(fixture.calls.every((argv) => !argv.at(-1)!.includes(" stop"))).toBe(true)
        expect((await new RemoteTargetStore(fixture.local).read("fixture-host"))?.consent.modelMode).toBe(
          mode,
        )
      } finally {
        await fixture.dispose()
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
}
