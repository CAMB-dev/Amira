import "../server/offline.ts"
import { expect, test } from "bun:test"
import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { SPAWN_TEST_TIMEOUT_MS } from "../../../../scripts/spawn-test.ts"
import { runRemoteCommand } from "../../src/remote/command.ts"
import { INSTALL_SCRIPT, PROBE_SCRIPT } from "../../src/remote/deployment-scripts.ts"
import { parseRemoteProbe } from "../../src/remote/install.ts"
import { REMOTE_PEER_LIMITS } from "../../src/remote/protocol.ts"
import { runSsh, sshArgv } from "../../src/remote/ssh.ts"
import { RemoteTargetStore } from "../../src/remote/targets.ts"
import {
  deploymentFixture,
  deploymentRelease,
  deploymentTarget,
  shellWords,
  signedBundle,
} from "./deployment-fixture.ts"

const oldRelease = { version: "0.0.9", buildId: "development-previous", target: deploymentTarget }

function hello(workspace: string) {
  return {
    v: 1 as const,
    kind: "hello" as const,
    clientId: "deployment-client",
    workspace,
    release: { ...deploymentRelease, target: deploymentTarget },
    limits: REMOTE_PEER_LIMITS,
    capabilities: ["model.proxy", "replay", "controller"],
  }
}

test(
  "first setup requires explicit consent and leaves no target or remote writes when declined",
  async () => {
    const fixture = await deploymentFixture()
    try {
      let asked = false
      await expect(
        runRemoteCommand(["add", "fixture-host"], {
          ...fixture.dependencies,
          interactive: true,
          consent: async (disclosure) => {
            asked = true
            expect(disclosure).toContain("user remote-user")
            expect(disclosure).toContain("Install location: /home/remote ' user/.amira/remote")
            expect(disclosure).toContain("Provider keys stay local")
            expect(disclosure).toContain("automatically install matching signed server builds")
            return false
          },
        }),
      ).rejects.toThrow("not approved")
      expect(asked).toBe(true)
      expect(fixture.calls).toHaveLength(1)
      expect(await fixture.state()).toBeUndefined()
      expect(await new RemoteTargetStore(fixture.local).read("fixture-host")).toBeUndefined()
      await expect(runRemoteCommand(["add", "fixture-host"], fixture.dependencies)).rejects.toThrow(
        "--accept-install",
      )
      expect(fixture.calls).toHaveLength(2)
    } finally {
      await fixture.dispose()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "consented add saves only after install; attach uses fresh local spawned protocol pipes and cwd data",
  async () => {
    const fixture = await deploymentFixture()
    try {
      const workspace = "/workspace/quoted ' ; $(not-a-command) `also-not-a-command`"
      await runRemoteCommand(
        ["add", "fixture-host", "--name", "work", "--cwd", workspace, "--accept-install"],
        fixture.dependencies,
      )
      expect(await fixture.state()).toEqual({ ...deploymentRelease, target: deploymentTarget })
      const record = await new RemoteTargetStore(fixture.local).read("work")
      expect(record?.workspace).toBe(workspace)
      expect(record?.consent).toEqual({ automaticUpdates: true, modelMode: "local-proxy" })
      expect(shellWords(fixture.calls[1]!.at(-1)!)[2]).toBe(INSTALL_SCRIPT)
      let attachments = 0
      await runRemoteCommand(["attach", "work"], {
        ...fixture.dependencies,
        consent: async () => {
          throw new Error("Saved consent must be reused")
        },
        attach: async (context) => {
          expect(context.workspace).toBe(workspace)
          for (let index = 0; index < 2; index++) {
            const connection = await context.connect({ hello: hello(workspace) })
            expect((await connection.ready).workspace).toBe(workspace)
            connection.close()
            await connection.closed
            attachments++
          }
        },
      })
      expect(attachments).toBe(2)
      expect(fixture.calls).toHaveLength(7) // add probe/upload, attach probe, two fresh probes/relays
      // add always takes an SSH host, whereas attach can select a saved target name.
      await expect(
        runRemoteCommand(["add", "work", "--accept-install"], fixture.dependencies),
      ).rejects.toThrow("another host")
      expect(fixture.calls).toHaveLength(7)
      for (const argv of fixture.calls) {
        expect(argv.slice(0, 6)).toEqual(["-T", "-a", "-o", "ForwardAgent=no", "--", "fixture-host"])
        expect(argv.at(-1)).not.toContain(workspace)
        expect(argv.join(" ")).not.toContain("StrictHostKeyChecking=no")
      }
    } finally {
      await fixture.dispose()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "two signed versions with the same commit install independently and retain both executables",
  async () => {
    const fixture = await deploymentFixture()
    try {
      const buildId = "c".repeat(40)
      const releases = [
        { version: "0.1.0", buildId, channel: "stable" },
        { version: "0.1.1-next.20261020", buildId, channel: "next" },
      ]
      for (const release of releases) {
        await fixture.configure(release)
        await runRemoteCommand(["add", "fixture-host", "--accept-install"], {
          ...fixture.dependencies,
          release,
          artifacts: { load: async () => signedBundle(release, Buffer.from(release.version)) },
        })
        expect(await fixture.state()).toEqual({ version: release.version, buildId, target: deploymentTarget })
      }
      const installs = fixture.calls.filter((argv) => shellWords(argv.at(-1)!)[2] === INSTALL_SCRIPT)
      const destinations = installs.map((argv) => `${shellWords(argv.at(-1)!)[5]}-${deploymentTarget}`)
      expect(new Set(destinations).size).toBe(2)
      for (let index = 0; index < releases.length; index++)
        expect(await readFile(path.join(fixture.remote, destinations[index]!), "utf8")).toBe(
          releases[index]!.version,
        )
      // Switching back reuses the immutable older executable and atomically republishes the launcher.
      const release = releases[0]!
      await fixture.configure(release)
      await runRemoteCommand(["add", "fixture-host"], {
        ...fixture.dependencies,
        release,
        artifacts: { load: async () => signedBundle(release, Buffer.from(release.version)) },
      })
      expect((await fixture.state())?.version).toBe(release.version)
    } finally {
      await fixture.dispose()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "each fresh relay reprobes and repairs a launcher replaced by another client before welcome validation",
  async () => {
    const fixture = await deploymentFixture()
    try {
      let loads = 0
      await runRemoteCommand(["attach", "fixture-host", "--accept-install"], {
        ...fixture.dependencies,
        artifacts: {
          load: async () => {
            loads++
            return signedBundle()
          },
        },
        attach: async (context) => {
          for (let index = 0; index < 2; index++) {
            await writeFile(path.join(fixture.remote, "installed.json"), JSON.stringify(oldRelease))
            const session = await context.open()
            try {
              expect(await fixture.state()).toEqual({ ...deploymentRelease, target: deploymentTarget })
              expect(context.installedRelease).toEqual({ ...deploymentRelease, target: deploymentTarget })
            } finally {
              session.close()
              await session.exited
            }
          }
        },
      })
      expect(loads).toBe(3)
      expect(fixture.calls.filter((argv) => shellWords(argv.at(-1)!)[2] === PROBE_SCRIPT)).toHaveLength(3)
    } finally {
      await fixture.dispose()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "fresh relays reauthenticate local artifacts and remote identity; failures never open a relay",
  async () => {
    const fixture = await deploymentFixture()
    try {
      let tampered = false
      await runRemoteCommand(["attach", "fixture-host", "--accept-install"], {
        ...fixture.dependencies,
        artifacts: {
          load: async () => {
            const bundle = signedBundle()
            return tampered ? { ...bundle, binary: Buffer.from("untrusted replacement") } : bundle
          },
        },
        attach: async (context) => {
          const before = fixture.calls.length
          tampered = true
          await expect(context.open()).rejects.toThrow("SHA-256")
          expect(fixture.calls).toHaveLength(before + 1) // probe only, no upload or relay
          tampered = false
          await fixture.configure({ home: "/home/changed-user" })
          await expect(context.open()).rejects.toThrow("approve setup again")
          expect(fixture.calls).toHaveLength(before + 2)
        },
      })
    } finally {
      await fixture.dispose()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "matching executable identity without authenticated matching bytes is repaired before reconnect",
  async () => {
    const fixture = await deploymentFixture()
    try {
      await runRemoteCommand(["attach", "fixture-host", "--accept-install"], {
        ...fixture.dependencies,
        attach: async (context) => {
          await writeFile(path.join(fixture.remote, "installed.sha256"), "0".repeat(64))
          const before = fixture.calls.length
          const connection = await context.connect({ hello: hello(context.workspace) })
          connection.close()
          await connection.closed
          expect(shellWords(fixture.calls[before + 1]!.at(-1)!)[2]).toBe(INSTALL_SCRIPT)
        },
      })
    } finally {
      await fixture.dispose()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

for (const failure of ["interrupted", "disk-full", "checksum", "identity", "self-check", "publish"]) {
  test(
    `failed ${failure} upload preserves previous installation and does not save consent`,
    async () => {
      const fixture = await deploymentFixture()
      try {
        await writeFile(path.join(fixture.remote, "installed.json"), JSON.stringify(oldRelease))
        await fixture.configure({ failure })
        await expect(
          runRemoteCommand(["add", "fixture-host", "--accept-install"], fixture.dependencies),
        ).rejects.toThrow("Remote setup failed")
        expect(await fixture.state()).toEqual(oldRelease)
        expect(await new RemoteTargetStore(fixture.local).read("fixture-host")).toBeUndefined()
        expect(await readdir(fixture.remote)).not.toContain("install-lock")
        expect(await readdir(fixture.remote)).not.toContain("upload.tmp")
      } finally {
        await fixture.dispose()
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
}

test(
  "saved consent permits an atomic update without restarting an incompatible active daemon",
  async () => {
    const fixture = await deploymentFixture()
    try {
      await runRemoteCommand(["add", "fixture-host", "--accept-install"], fixture.dependencies)
      // The previously approved target has an older installed executable and an older live daemon.
      await writeFile(path.join(fixture.remote, "installed.json"), JSON.stringify(oldRelease))
      await fixture.configure({ runningRelease: oldRelease })
      await expect(
        runRemoteCommand(["attach", "fixture-host"], {
          ...fixture.dependencies,
          attach: async (context) => {
            await context.connect({ hello: hello(context.workspace) })
          },
        }),
      ).rejects.toThrow("No running work was stopped")
      expect(await fixture.state()).toEqual({ ...deploymentRelease, target: deploymentTarget })
      expect(fixture.calls).toHaveLength(6)
      expect(fixture.calls.every((argv) => !argv.at(-1)!.includes(" stop"))).toBe(true)
      let pending = false
      await runRemoteCommand(["attach", "fixture-host"], {
        ...fixture.dependencies,
        compatibleDaemon: (welcome) => welcome.capabilities.includes("replay"),
        attach: async (context) => {
          const connection = await context.connect({ hello: hello(context.workspace) })
          pending = context.validateWelcome(await connection.ready).replacementPending
          connection.close()
        },
      })
      expect(pending).toBe(true)
    } finally {
      await fixture.dispose()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "remote identity changes require consent again; failures keep the saved target unchanged",
  async () => {
    const fixture = await deploymentFixture()
    try {
      await runRemoteCommand(["add", "fixture-host", "--accept-install"], fixture.dependencies)
      const store = new RemoteTargetStore(fixture.local)
      const previous = await store.read("fixture-host")
      await fixture.configure({ home: "/home/different-user" })
      await expect(runRemoteCommand(["add", "fixture-host"], fixture.dependencies)).rejects.toThrow(
        "not approved",
      )
      expect(await store.read("fixture-host")).toEqual(previous)
    } finally {
      await fixture.dispose()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "invalid platform fails before artifact selection or consent",
  async () => {
    const fixture = await deploymentFixture()
    try {
      await fixture.configure({ arch: "riscv64" })
      await expect(
        runRemoteCommand(["add", "fixture-host", "--accept-install"], {
          ...fixture.dependencies,
          artifacts: {
            load: async () => {
              throw new Error("Artifacts must not be loaded")
            },
          },
        }),
      ).rejects.toThrow("Unsupported remote architecture")
      expect(fixture.calls).toHaveLength(1)
      expect(shellWords(fixture.calls[0]!.at(-1)!)[2]).toBe(PROBE_SCRIPT)
    } finally {
      await fixture.dispose()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "SSH diagnostics/output are bounded and timeout closes and reaps the owned local child",
  async () => {
    const fixture = await deploymentFixture()
    try {
      await fixture.configure({ probeFlood: true })
      await expect(
        runSsh(fixture.dependencies.launcher!, sshArgv("fixture-host", PROBE_SCRIPT)),
      ).rejects.toThrow("deployment limit")
      await fixture.configure({ probeFlood: false, probeHang: true })
      await expect(
        runSsh(fixture.dependencies.launcher!, sshArgv("fixture-host", PROBE_SCRIPT), undefined, {
          timeoutMs: 50,
        }),
      ).rejects.toThrow("timed out")
      await fixture.configure({ probeHang: false, failure: "self-check", stderrFlood: true })
      let message = ""
      try {
        await runRemoteCommand(["add", "fixture-host", "--accept-install"], fixture.dependencies)
      } catch (error) {
        message = (error as Error).message
      }
      expect(message.length).toBeLessThan(17 * 1024)
      expect(message).toContain("self-check failed")
      expect(message).not.toContain(String.fromCharCode(27))
      for (const child of fixture.children) expect(Number.isInteger(await child.exited)).toBe(true)
    } finally {
      await fixture.dispose()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "unverified local artifacts cannot reach upload or persist first-use consent",
  async () => {
    const fixture = await deploymentFixture()
    try {
      await expect(
        runRemoteCommand(["add", "fixture-host", "--accept-install"], {
          ...fixture.dependencies,
          publicKey: "",
        }),
      ).rejects.toThrow("trusted server release public key")
      expect(fixture.calls).toHaveLength(1)
      expect(await fixture.state()).toBeUndefined()
      expect(await new RemoteTargetStore(fixture.local).read("fixture-host")).toBeUndefined()
    } finally {
      await fixture.dispose()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test("probe explicitly maps supported architectures and rejects unsupported libc, CPU and malformed output", () => {
  const probe = (overrides: Record<number, string> = {}) => {
    const fields = ["Linux", "x86_64", "/home/test", "test", "1000", "glibc 2.28", "baseline", "", "", ""]
    for (const [index, value] of Object.entries(overrides)) fields[Number(index)] = value
    return Buffer.from(fields.join("\0"))
  }
  expect(parseRemoteProbe(probe()).target).toBe(deploymentTarget)
  expect(parseRemoteProbe(probe({ 8: "a".repeat(64) })).installedHash).toBe("a".repeat(64))
  expect(() => parseRemoteProbe(probe({ 8: "untrusted-hash" }))).toThrow("Invalid installed server hash")
  expect(parseRemoteProbe(probe({ 1: "aarch64", 6: "arm64" })).target).toBe("bun-linux-arm64")
  expect(parseRemoteProbe(probe({ 1: "arm64", 6: "arm64" })).target).toBe("bun-linux-arm64")
  expect(() => parseRemoteProbe(probe({ 0: "Darwin" }))).toThrow("Linux")
  expect(() => parseRemoteProbe(probe({ 5: "musl" }))).toThrow("glibc 2.28")
  expect(() => parseRemoteProbe(probe({ 5: "glibc 2.27" }))).toThrow("glibc 2.28")
  expect(() => parseRemoteProbe(probe({ 6: "unknown" }))).toThrow("SSE4.2")
  expect(() => parseRemoteProbe(Buffer.from("banner\n"))).toThrow("Invalid remote probe")
})
