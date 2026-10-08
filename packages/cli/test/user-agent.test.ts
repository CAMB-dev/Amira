import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fetchPublic, guardedFetch } from "@amira/api"
import "@amira/core"
import pkg from "../package.json" with { type: "json" }
import { USER_AGENT } from "../src/user-agent.ts"

const webUserAgent = `Mozilla/5.0 (compatible; Amira/${pkg.version}; +https://github.com/CAMB-dev/Amira)`

test("extension net helpers use the browser-compatible UA with the CLI version", async () => {
  const headers: Headers[] = []
  const fetch = (async (_input, init) => {
    headers.push(new Headers(init?.headers))
    return new Response("ok")
  }) as typeof globalThis.fetch
  const resolve = async () => ["93.184.215.14"]
  const signal = new AbortController().signal
  await guardedFetch(new URL("https://example.test/"), { fetch, resolve }, signal)
  await fetchPublic("https://example.test/", { fetch, resolve, signal, maxBytes: 100 })
  expect(USER_AGENT).toBe(`Amira/${pkg.version}`)
  expect(headers.map((h) => h.get("user-agent"))).toEqual([webUserAgent, webUserAgent])
})

test("compiled binaries retain both bundled User-Agents", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "amira-user-agent-"))
  try {
    const entry = path.join(dir, "entry.ts")
    const binary = path.join(dir, process.platform === "win32" ? "ua.exe" : "ua")
    const cli = path.resolve(import.meta.dir, "../src/user-agent.ts").replaceAll("\\", "/")
    const net = path.resolve(import.meta.dir, "../../net/src/index.ts").replaceAll("\\", "/")
    await writeFile(
      entry,
      `import { USER_AGENT } from ${JSON.stringify(cli)}\n` +
        `import { USER_AGENT as WEB_USER_AGENT } from ${JSON.stringify(net)}\n` +
        "console.log(JSON.stringify([USER_AGENT, WEB_USER_AGENT]))\n",
    )
    execFileSync(process.execPath, ["build", "--compile", entry, "--outfile", binary], {
      timeout: 600_000,
      stdio: "pipe",
    })
    const output = execFileSync(binary, [], { cwd: dir, encoding: "utf8", timeout: 600_000 })
    expect(JSON.parse(output)).toEqual([`Amira/${pkg.version}`, webUserAgent])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 600_000)
