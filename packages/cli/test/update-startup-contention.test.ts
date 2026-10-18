import { afterEach, expect, test } from "bun:test"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Settings } from "@amira/api"
import { createUpdater, type UpdaterOptions } from "../src/update/index.ts"
import { liveVersionLeases } from "../src/update/version-leases.ts"
import { startBackgroundUpdate } from "../src/update-background.ts"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

for (const phase of ["manifest", "archive"] as const) {
  test(`sessions start while another updater waits on a ${phase}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "amira-startup-contention-"))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const bin = path.join(root, "bin", "amira.exe")
    await mkdir(path.dirname(bin))
    await mkdir(path.join(root, "versions", "1.2.3"), { recursive: true })
    await writeFile(bin, "1.2.3")
    await writeFile(path.join(root, "versions", "1.2.3", "amira.exe"), "1.2.3")
    const target = "bun-windows-x64-baseline"
    await writeFile(
      path.join(root, "install.json"),
      JSON.stringify({ kind: "single-file", version: "1.2.3", channel: "stable", target, bin }),
    )
    const bytes = Buffer.from("fixture archive")
    const manifest = JSON.stringify({
      version: "1.2.4",
      channel: "stable",
      artifacts: [
        {
          target,
          file: `amira-${target}.zip`,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    })
    const keys = generateKeyPairSync("ed25519")
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const requests: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname
        requests.push(pathname)
        if (pathname === (phase === "manifest" ? "/manifest.json" : "/archive")) {
          entered.resolve()
          await release.promise
        }
        if (pathname === "/manifest.json") return new Response(manifest)
        if (pathname === "/manifest.json.sig")
          return new Response(sign(null, Buffer.from(manifest), keys.privateKey).toString("base64"))
        return new Response(bytes)
      },
    })
    cleanups.push(() => server.stop(true))
    const options: UpdaterOptions = {
      version: "1.2.3",
      target,
      installRoot: root,
      bin,
      executable: bin,
      platform: "win32",
      env: {},
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      manifestUrl: () => `${server.url}manifest.json`,
      artifactUrl: () => `${server.url}archive`,
      extract: async (_archive, directory, name) => {
        await writeFile(path.join(directory, name), "1.2.4")
      },
      probe: async (file) => readFile(file, "utf8"),
    }
    const first = createUpdater(options)
    const operation = (phase === "manifest" ? first.check() : first.update()).catch((error) => error)
    await entered.promise
    try {
      const scenarios: Array<{
        checks?: boolean
        env?: NodeJS.ProcessEnv
        settings?: Settings
        publicKey?: string
      }> = [
        {},
        { checks: false },
        { settings: { updates: { auto: false } } },
        { env: { AMIRA_DISABLE_UPDATES: "1" } },
        { env: { AMIRA_OFFLINE: "1" } },
        { env: { AMIRA_DISABLE_AUTOUPDATE: "1" } },
        { publicKey: "" },
      ]
      for (const [index, scenario] of scenarios.entries()) {
        const second = createUpdater({
          ...options,
          ...(scenario.env ? { env: scenario.env } : {}),
          ...(scenario.publicKey !== undefined ? { publicKey: scenario.publicKey } : {}),
        })
        const startup = await Promise.race([
          startBackgroundUpdate(scenario.settings ?? {}, {
            updater: second,
            env: scenario.env ?? {},
            checks: scenario.checks,
            stateFile: path.join(root, `state-${index}.json`),
          }),
          Bun.sleep(1000).then(() => {
            throw new Error("Session startup waited for the download lock")
          }),
        ])
        await startup.finished
        expect((await liveVersionLeases(root))?.has("1.2.3")).toBe(true)
        expect(await readdir(path.join(root, "leases", "1.2.3"))).toHaveLength(2)
        await startup.stop()
        expect(await readdir(path.join(root, "leases", "1.2.3"))).toHaveLength(1)
      }
      expect(requests.filter((request) => request === "/manifest.json")).toHaveLength(1)
      expect(requests.filter((request) => request === "/archive")).toHaveLength(phase === "archive" ? 1 : 0)
    } finally {
      release.resolve()
      await operation
      await first.stop()
    }
  }, 30_000)
}
