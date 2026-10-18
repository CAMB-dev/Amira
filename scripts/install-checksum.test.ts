import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), "amira-checksum-"))
  temporary.push(root)
  return root
}

// Windows hosts without Git's sh on PATH cannot run the POSIX installer fragments.
const hasSh = Bun.which("sh") !== null

for (const fallback of [false, true]) {
  test.skipIf(!hasSh)(
    `installer ${fallback ? "shasum" : "sha256sum"} hashes stdin for backslash-containing paths`,
    async () => {
      const root = await directory()
      // A native Windows path contains backslashes too; GNU checksum output escapes its filename.
      const staging = process.platform === "win32" ? root : path.join(root, "home\\with-backslash")
      await mkdir(staging, { recursive: true })
      const bytes = Buffer.from("an isolated archive fixture")
      await writeFile(path.join(staging, "archive.tar.gz"), bytes)
      const source = await readFile(new URL("../install.sh", import.meta.url), "utf8")
      const block = source.match(/if command -v sha256sum[^\n]*\n[\s\S]*?\nfi/)?.[0]
      expect(block).toBeDefined()
      // Exercise the fallback's stdin contract even on hosts without Perl's shasum.
      const forceFallback = fallback
        ? `
command() { return 1; }
shasum() {
  [ "$#" -eq 2 ] && [ "$1" = -a ] && [ "$2" = 256 ] || return 1
  sha256sum
}
`
        : ""
      const child = Bun.spawn(["sh", "-c", `${forceFallback}\n${block}\nprintf '%s' "$actual"`], {
        env: { ...process.env, staging },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(stderr).toBe("")
      expect(code).toBe(0)
      expect(stdout).toBe(createHash("sha256").update(bytes).digest("hex"))
    },
  )
}

test.skipIf(process.platform === "win32")("Unix installer accepts a literal backslash in HOME", async () => {
  const root = await directory()
  const payload = path.join(root, "payload")
  await mkdir(payload)
  await writeFile(path.join(payload, "amira"), "#!/bin/sh\necho '1.2.3 (stable)'\n")
  await chmod(path.join(payload, "amira"), 0o755)
  const archive = path.join(root, "archive.tar.gz")
  const tar = Bun.spawn(["tar", "-czf", archive, "-C", payload, "amira"], { stderr: "pipe" })
  expect(await tar.exited).toBe(0)
  const bytes = await readFile(archive)
  const target = `bun-${process.platform}-${process.arch}${process.platform === "linux" && process.arch === "x64" ? "-baseline" : ""}`
  const manifest = `${JSON.stringify(
    {
      version: "1.2.3",
      channel: "stable",
      artifacts: [
        {
          target,
          file: `amira-${target}.tar.gz`,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      ],
    },
    null,
    2,
  )}\n`
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return new Response(new URL(request.url).pathname.endsWith("manifest.json") ? manifest : bytes)
    },
  })
  try {
    const script = path.join(root, "install.sh")
    const source = await readFile(new URL("../install.sh", import.meta.url), "utf8")
    await writeFile(
      script,
      source.replace(
        "https://github.com/CAMB-dev/Amira/releases",
        `http://127.0.0.1:${server.port}/releases`,
      ),
    )
    const home = path.join(root, "home\\with-backslash")
    await mkdir(home)
    const child = Bun.spawn(["sh", script, "--version", "1.2.3"], {
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderr = await new Response(child.stderr).text()
    expect({ code: await child.exited, stderr: stderr.includes("mismatch") }).toEqual({
      code: 0,
      stderr: false,
    })
    expect(await readlink(path.join(home, ".local/bin/amira"))).toBe(
      path.join(home, ".local/share/amira/versions/1.2.3/amira"),
    )
  } finally {
    await server.stop(true)
  }
})
