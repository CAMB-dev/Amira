import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ExtensionStatus } from "@amira/api"
import { packageDir, packageScope, readLock, writeLock } from "@amira/packages"
import { SPAWN_TEST_TIMEOUT_MS } from "../../../scripts/spawn-test.ts"
import { runExtCommand } from "../src/ext-command.ts"

let root: string
let home: string
let cwd: string

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "amira-ext-status-"))
  home = path.join(root, "home")
  cwd = path.join(root, "project")
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
})

afterEach(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }))

function capture() {
  const io = {
    out: "",
    err: "",
    stdout(text: string) {
      io.out += text
    },
    stderr(text: string) {
      io.err += text
    },
  }
  return io
}

function source(status?: ExtensionStatus, version = "1.0.0") {
  const dir = path.join(root, "source")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "project",
      version,
      amira: { status, statusMessage: "Not ready yet", replacedBy: "bar" },
    }),
  )
  writeFileSync(path.join(dir, "index.ts"), "export default () => {}\n")
  return dir
}

const messages = {
  experimental: "note: project is experimental: Not ready yet",
  wip: "warning: project is work in progress: Not ready yet",
  deprecated: "warning: project is deprecated; use bar instead: Not ready yet",
}

for (const status of ["experimental", "wip", "deprecated"] as const) {
  for (const mode of ["plain", "quiet", "json", "tty"] as const) {
    test(`${status} install/update notices in ${mode} mode`, async () => {
      const opts = { home, cwd, tty: mode === "tty", spinnerMs: 0 }
      const flags = mode === "json" ? ["--json"] : mode === "quiet" ? ["--quiet"] : []
      const dir = source(status)
      for (const operation of ["install", "update", "update"] as const) {
        const io = capture()
        expect(
          await runExtCommand([operation, ...flags, ...(operation === "install" ? [dir] : [])], io, opts),
        ).toBe(0)
        if (mode === "json") {
          expect(io.err).toBe("")
          const events = io.out
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
          expect(events.filter((event) => event.type === "status")).toEqual([
            {
              type: "status",
              name: "project",
              status: {
                kind: status,
                message: "Not ready yet",
                ...(status === "deprecated" ? { replacedBy: "bar" } : {}),
              },
              level: status === "experimental" ? "note" : "warning",
              message: messages[status],
            },
          ])
          // Existing consumers still receive the operation outcome in result.status.
          expect(events.find((event) => event.type === "result").status).toBe(
            operation === "install" ? "installed" : "up to date",
          )
        } else {
          const notices = io.err.split("\n").filter((line) => line.includes(messages[status]))
          expect(notices).toHaveLength(mode === "quiet" && status === "experimental" ? 0 : 1)
        }
      }
    })
  }

  test(`list shows ${status} beside the name, with structured JSON metadata`, async () => {
    await runExtCommand(["install", "--quiet", source(status)], capture(), { home, cwd })
    const text = capture()
    expect(await runExtCommand(["list"], text, { home, cwd })).toBe(0)
    expect(text.out).toContain(`project [${status}] 1.0.0`)
    expect(text.err).toBe("")
    const json = capture()
    await runExtCommand(["list", "--json"], json, { home, cwd })
    expect(JSON.parse(json.out)).toMatchObject([
      {
        name: "project",
        scope: "user",
        status: {
          kind: status,
          message: "Not ready yet",
          ...(status === "deprecated" ? { replacedBy: "bar" } : {}),
        },
      },
    ])
  })
}

test("packages without a status keep plain output and have no JSON status metadata", async () => {
  const io = capture()
  await runExtCommand(["install", "--quiet", source()], io, { home, cwd })
  expect(io.err).toBe("")
  const json = capture()
  await runExtCommand(["list", "--json"], json, { home, cwd })
  expect(JSON.parse(json.out)[0]).not.toHaveProperty("status")
})

test("changed versions and lock-file restores also report lifecycle warnings once", async () => {
  await runExtCommand(["install", "--quiet", source()], capture(), { home, cwd })
  source("wip", "1.1.0")
  const updated = capture()
  await runExtCommand(["update", "--quiet"], updated, { home, cwd })
  expect(updated.out).toContain("Updated project")
  expect(updated.err).toBe(`${messages.wip}\n`)
  rmSync(packageDir(packageScope("user", { home, cwd }), "project"), { recursive: true, force: true })
  const restored = capture()
  await runExtCommand(["install", "--quiet"], restored, { home, cwd })
  expect(restored.err).toBe(`${messages.wip}\n`)
})

function registry() {
  let status: ExtensionStatus = "experimental"
  let version = "1.0.0"
  const fetch: typeof globalThis.fetch = Object.assign(
    async (url: string | URL | Request) => {
      if (String(url) === "https://registry.invalid/project.tgz") {
        const archive = new Bun.Archive(
          {
            "package/package.json": JSON.stringify({
              name: "project",
              version,
              amira: { extensions: [], status, statusMessage: "Not ready yet", replacedBy: "bar" },
            }),
          },
          { compress: "gzip" },
        )
        return new Response(await archive.blob())
      }
      expect(String(url)).toMatch(/\/project$/)
      return Response.json({
        "dist-tags": { latest: version },
        versions: { [version]: { dist: { tarball: "https://registry.invalid/project.tgz" } } },
      })
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  return {
    fetch,
    setStatus(value: ExtensionStatus) {
      status = value
      version = "1.1.0"
    },
  }
}

for (const operation of ["install", "update"] as const) {
  for (const status of ["wip", "deprecated"] as const) {
    test(
      `suppressed experimental index notes do not hide ${status} manifest warnings during ${operation} --quiet`,
      async () => {
        const url = path.join(root, "index.json")
        writeFileSync(
          url,
          JSON.stringify({
            schemaVersion: 1,
            extensions: [{ name: "project", source: { npm: "project" }, status: "experimental" }],
          }),
        )
        const stub = registry()
        const opts = { home, cwd, index: { url }, fetch: stub.fetch }
        if (operation === "update") {
          const initial = capture()
          expect(await runExtCommand(["install", "project", "--quiet"], initial, opts)).toBe(0)
          expect(initial.err).toBe("")
        }
        stub.setStatus(status)
        const io = capture()
        expect(await runExtCommand([operation, "project", "--quiet"], io, opts)).toBe(0)
        expect(io.err).toBe(`${messages[status]}\n`)
        const json = capture()
        expect(await runExtCommand(["list", "--json"], json, { home, cwd })).toBe(0)
        expect(JSON.parse(json.out)[0].status.kind).toBe(status)
      },
      SPAWN_TEST_TIMEOUT_MS,
    )
  }

  test(`index status warns before ${operation} downloads, even if the download fails`, async () => {
    const url = path.join(root, "index.json")
    writeFileSync(
      url,
      JSON.stringify({
        schemaVersion: 1,
        extensions: [{ name: "project", source: { npm: "project" }, status: "wip" }],
      }),
    )
    if (operation === "update") {
      await runExtCommand(["install", "--quiet", source()], capture(), { home, cwd })
      const scope = packageScope("user", { home, cwd })
      const lock = readLock(scope.lockFile)
      lock.packages.project!.index = { name: "project", url }
      writeLock(scope.lockFile, lock)
    }
    const io = capture()
    let requested = false
    const fetch: typeof globalThis.fetch = Object.assign(
      async () => {
        requested = true
        expect(io.err).toBe("warning: project is work in progress\n")
        return new Response("fixture failure", { status: 500 })
      },
      { preconnect: globalThis.fetch.preconnect },
    )
    expect(
      await runExtCommand([operation, "project", "--quiet"], io, {
        home,
        cwd,
        index: { url },
        fetch,
      }),
    ).toBe(1)
    expect(requested).toBe(true)
    expect(io.err.match(/warning: project is work in progress/g)).toHaveLength(1)
  })
}
