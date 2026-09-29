import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { activePackages } from "@amira/core"
import { runExtCommand } from "../src/ext-command.ts"
import { amiraArgv, runPackageCommand } from "../src/package-command.ts"
import { createSession } from "../src/session.ts"

let dir: string
let home: string
let cwd: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "amira-cli-packages-"))
  home = path.join(dir, "home")
  cwd = path.join(dir, "project")
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
})

afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))

function capture() {
  const c = {
    out: "",
    err: "",
    stdout: (s: string) => {
      c.out += s
    },
    stderr: (s: string) => {
      c.err += s
    },
  }
  return c
}

/** A package whose extension registers the tool `tool`; `amira` goes into the manifest. */
function makePackage(name: string, version: string, tool: string, amira: object = {}) {
  const at = path.join(dir, "sources", `${name}-${version}`)
  mkdirSync(at, { recursive: true })
  writeFileSync(path.join(at, "package.json"), JSON.stringify({ name, version, type: "module", amira }))
  writeFileSync(
    path.join(at, "index.ts"),
    `import { defineTool } from "@amira/api"
export default (amira) => { amira.registerTool(defineTool({ name: ${JSON.stringify(tool)}, description: "", parameters: {}, execute: async () => ({ content: [] }) })) }\n`,
  )
  return at
}

const ext = (argv: string[], io = capture(), index?: string) =>
  runExtCommand(argv, io, { home, cwd, ...(index ? { index: { url: index } } : {}) }).then((code) => ({
    code,
    io,
  }))

test("installed packages load at startup after the built-ins, project over user", async () => {
  expect((await ext(["install", makePackage("shared", "1.0.0", "user_tool")])).code).toBe(0)
  expect((await ext(["install", makePackage("extra", "1.0.0", "extra_tool")])).code).toBe(0)
  expect((await ext(["install", "--project", makePackage("shared", "2.0.0", "project_tool")])).code).toBe(0)
  // A project lock entry whose files are missing is reported, not fatal.
  const lock = path.join(cwd, ".amira", "packages.lock")
  const text = JSON.parse(await Bun.file(lock).text())
  text.packages.ghost = { ...text.packages.shared }
  writeFileSync(lock, JSON.stringify(text))

  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const session = await createSession({
    model: "mock/m",
    cwd,
    extensions: [],
    packages: activePackages({ home, cwd }),
    noBuiltins: false,
    builtins: async () => [
      { source: "builtin:x", extension: (api) => void api.registerTool(tool("builtin_tool")) },
    ],
    ai,
  })
  const names = session.agent.tools.all().map((t) => t.tool.name)
  expect(names).toEqual(["builtin_tool", "extra_tool", "project_tool"])
  const events = session.startupEvents as AnyEvent[]
  const loaded = events
    .filter((e) => e.type === "extension.loaded")
    .map((e) => (e.data as { source: string }).source)
  expect(loaded[0]).toBe("builtin:x")
  expect(loaded.slice(1)).toEqual([
    path.join(home, "packages", "extra", "index.ts"),
    path.join(cwd, ".amira", "packages", "shared", "index.ts"),
  ])
  const errors = events.filter((e) => e.type === "extension.error").map((e) => e.data)
  expect(errors).toEqual([
    { source: "package:ghost", error: expect.stringContaining("amira ext install --project") },
  ])
})

test("package skill directories are added to the skills search", async () => {
  const src = makePackage("with-skills", "1.0.0", "t", { skills: ["./skills"] })
  await ext(["install", src])
  let seen: unknown
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  await createSession({
    model: "mock/m",
    cwd,
    extensions: [],
    packages: activePackages({ home, cwd }),
    noBuiltins: false,
    builtins: async () => [
      {
        source: "builtin:probe",
        extension: (api) => {
          seen = api.settings.skills?.dirs
        },
      },
    ],
    settings: { skills: { dirs: ["mine"] } },
    ai,
  })
  expect(seen).toEqual(["mine", path.join(home, "packages", "with-skills", "skills")])
})

test("ext list, search and remove", async () => {
  const src = makePackage("listed", "1.2.0", "t")
  await ext(["install", src])
  const index = path.join(dir, "index.json")
  writeFileSync(
    index,
    JSON.stringify({
      schemaVersion: 1,
      extensions: [
        {
          name: "listed",
          description: "Lists things",
          version: "1.2.0",
          source: { git: "file:///x" },
          tags: ["a"],
        },
        {
          name: "other",
          description: "Something else",
          version: "0.1.0",
          source: { npm: "other" },
          tags: [],
        },
      ],
    }),
  )
  const list = await ext(["list"])
  expect(list.io.out).toContain("listed 1.2.0 (local copy)")
  expect(list.io.out).toContain(`from ${src}`)
  expect(list.io.out).toMatch(/project \(.*\):\n {2}\(none\)/)

  const search = await ext(["search", "things"], capture(), index)
  expect(search.io.out).toBe("listed 1.2.0  [installed: user]\n  Lists things\n  tags: a\n")
  const none = await ext(["search", "zzz"], capture(), index)
  expect(none.io.out).toContain("No extensions match")

  const wrongScope = await ext(["remove", "--project", "listed"])
  expect(wrongScope.code).toBe(1)
  expect(wrongScope.io.err).toContain("it is in the user scope")
  expect((await ext(["remove", "listed"])).io.out).toBe("Removed listed from user scope.\n")
  expect((await ext(["list"])).io.out).not.toContain("listed")
})

test("ext update reports each package; one that fails keeps its version and makes the exit code 1", async () => {
  await ext(["install", makePackage("kept", "1.0.0", "k")])
  const gone = makePackage("gone", "1.0.0", "g")
  await ext(["install", gone])
  rmSync(gone, { recursive: true, force: true })
  const r = await ext(["update"])
  expect(r.code).toBe(1)
  expect(r.io.out).toBe("kept is up to date (1.0.0 (local copy))\n")
  expect(r.io.err).toMatch(/^amira: gone: update failed, kept 1\.0\.0 \(local copy\): .* does not exist\n$/)
  expect((await ext(["list"])).io.out).toContain("gone 1.0.0 (local copy)")
})

test("an install failure is reported without a stack", async () => {
  const r = await ext(["install", path.join(dir, "missing")])
  expect(r.code).toBe(1)
  expect(r.io.err).toContain("does not exist")
  const unknown = await ext(["install", "no-such-ext"], capture(), path.join(dir, "absent-index.json"))
  expect(unknown.code).toBe(1)
  expect(unknown.io.err).toContain("cannot read the extensions index")
})

test("a package command runs as amira <name> with the rest of the arguments", async () => {
  const src = makePackage("cmd-pkg", "1.0.0", "t", { commands: { hello: "./hello.ts" } })
  writeFileSync(
    path.join(src, "hello.ts"),
    `export default (ctx) => { ctx.stdout(JSON.stringify({ argv: ctx.argv, api: ctx.apiVersion, amira: ctx.amiraArgv.length > 0 })); return 3 }\n`,
  )
  await ext(["install", src])
  const io = capture()
  expect(await runPackageCommand(["hello", "a", "-b"], io, { cwd, home })).toBe(3)
  expect(JSON.parse(io.out)).toEqual({ argv: ["a", "-b"], api: expect.any(String), amira: true })
  expect(await runPackageCommand(["nothing"], io, { cwd, home })).toBeUndefined()
  expect(await runPackageCommand(["-p", "hi"], io, { cwd, home })).toBeUndefined()
})

test("amiraArgv reruns the script when running from source, else the executable", () => {
  expect(amiraArgv(["bun", import.meta.path], "bun.exe")).toEqual(["bun.exe", import.meta.path])
  expect(amiraArgv(["amira.exe", "B:/~BUN/root/amira"], "amira.exe")).toEqual(["amira.exe"])
})

function tool(name: string) {
  return { name, description: "", parameters: {}, execute: async () => ({ content: [] }) }
}
