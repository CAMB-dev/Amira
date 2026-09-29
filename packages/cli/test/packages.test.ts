import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { activePackages, projectTrust } from "@amira/core"
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
  // Named after their packages, not their files.
  expect(loaded.slice(1)).toEqual(["extra", "shared"])
  const errors = events.filter((e) => e.type === "extension.error").map((e) => e.data)
  expect(errors).toEqual([{ source: "ghost", error: expect.stringContaining("amira ext install --project") }])
})

test("disabled packages and an untrusted project's packages do not load; a reload sees what changed", async () => {
  expect((await ext(["install", makePackage("shared", "1.0.0", "user_tool")])).code).toBe(0)
  expect((await ext(["install", makePackage("extra", "1.0.0", "extra_tool")])).code).toBe(0)
  expect((await ext(["install", "--project", makePackage("shared", "2.0.0", "project_tool")])).code).toBe(0)
  const untrusted = activePackages({ home, cwd }, { project: false })
  // The user's own package of the same name loads in place of the project's.
  expect(untrusted.packages.map((p) => `${p.scope}:${p.name}`)).toEqual(["user:extra", "user:shared"])
  expect(untrusted.skipped).toEqual([{ name: "shared", scope: "project", why: "untrusted" }])
  const disabled = activePackages({ home, cwd }, { disabled: ["extra"] })
  expect(disabled.packages.map((p) => `${p.scope}:${p.name}`)).toEqual(["project:shared"])
  expect(disabled.skipped).toEqual([{ name: "extra", scope: "user", why: "disabled" }])

  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  let off: string[] = ["extra"]
  const session = await createSession({
    model: "mock/m",
    cwd,
    extensions: [],
    packages: () => activePackages({ home, cwd }, { disabled: off, project: false }),
    noBuiltins: true,
    ai,
  })
  const notices = (session.startupEvents as AnyEvent[]).filter((e) => e.type === "extension.notice")
  expect(notices.map((e) => (e.data as { text: string }).text)).toEqual([
    expect.stringContaining("Not loading this project's extension packages (shared)"),
  ])
  expect(session.agent.tools.all().map((t) => t.tool.name)).toEqual(["user_tool"])
  off = []
  const report = await session.reload()
  expect(report).toMatchObject({ loaded: ["extra"], unloaded: [], failed: [], extensions: 2 })
  expect(session.agent.tools.all().map((t) => t.tool.name)).toEqual(["extra_tool", "user_tool"])
})

test("ext disable, enable, trust and untrust change the user settings, never a lock file", async () => {
  expect((await ext(["install", makePackage("quiet", "1.0.0", "q")])).code).toBe(0)
  const lock = await Bun.file(path.join(home, "packages.lock")).text()
  const off = await ext(["disable", "quiet"])
  expect(off.code).toBe(0)
  expect(off.io.out).toContain("quiet is disabled now.")
  expect(off.io.out).toContain("/reload")
  const settings = () => JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"))
  expect(settings().packages).toEqual({ disabled: ["quiet"] })
  expect((await ext(["list"])).io.out).toContain("[disabled: amira ext enable]")
  expect((await ext(["disable", "quiet"])).io.out).toContain("quiet was already disabled.")
  expect((await ext(["enable", "quiet"])).code).toBe(0)
  expect(settings().packages).toBeUndefined()
  expect(await Bun.file(path.join(home, "packages.lock")).text()).toBe(lock)
  const unknown = await ext(["disable", "nothing"])
  expect(unknown.code).toBe(1)
  expect(unknown.io.err).toContain("nothing is not installed")

  expect((await ext(["untrust"])).code).toBe(0)
  expect(projectTrust(cwd, { packages: settings().packages })).toBe(false)
  expect((await ext(["trust"])).code).toBe(0)
  expect(settings().packages).toEqual({ trustedProjects: [path.resolve(cwd)] })
  expect(projectTrust(path.join(cwd, "sub"), { packages: settings().packages })).toBe(true)
})

test("installing and removing say how to load the change", async () => {
  const installed = await ext(["install", makePackage("fresh", "1.0.0", "f")])
  expect(installed.io.out).toContain("run /reload in a running session")
  const removed = await ext(["remove", "fresh"])
  expect(removed.io.out).toContain("run /reload in a running session")
  expect((await ext(["install", "-q", makePackage("fresh", "1.0.0", "f")])).io.out).not.toContain("/reload")
})

test("the first start in a project with packages asks once whether to trust it, and remembers", async () => {
  const { planPackages } = await import("../src/trust.ts")
  expect((await ext(["install", "--project", makePackage("local", "1.0.0", "local_tool")])).code).toBe(0)
  const asked: string[][] = []
  const ask = async (names: string[]) => {
    asked.push(names)
    return false
  }
  const first = await planPackages({ cwd, home, settings: {}, ask })
  expect(asked).toEqual([["local"]])
  expect(first.packages().skipped).toEqual([{ name: "local", scope: "project", why: "untrusted" }])
  const settings = JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"))
  expect(settings.packages.untrustedProjects).toEqual([path.resolve(cwd)])
  // Next time the answer is known: nobody is asked.
  const again = await planPackages({ cwd, home, settings: { packages: settings.packages }, ask })
  expect(asked).toHaveLength(1)
  expect(again.packages().packages).toEqual([])
  // --no-packages: none at all.
  const none = await planPackages({ cwd, home, settings: {}, noPackages: true, ask })
  expect(none.packages()).toEqual({ packages: [], problems: [], skipped: [] })
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
  expect((await ext(["remove", "listed"])).io.out).toBe(
    "Removed listed from user scope.\n1 removed\nStart amira again, or run /reload in a running session, to load the change.\n",
  )
  expect((await ext(["list"])).io.out).not.toContain("listed")
})

test("ext update reports each package; one that fails keeps its version and makes the exit code 1", async () => {
  await ext(["install", makePackage("kept", "1.0.0", "k")])
  const gone = makePackage("gone", "1.0.0", "g")
  await ext(["install", gone])
  rmSync(gone, { recursive: true, force: true })
  const r = await ext(["update"])
  expect(r.code).toBe(1)
  expect(r.io.out).toBe("kept is up to date (1.0.0 (local copy))\n1 up to date · 1 failed\n")
  // Without a terminal, each phase is a line on stderr.
  expect(r.io.err).toMatch(
    /^amira: gone: update failed, kept 1\.0\.0 \(local copy\): .* does not exist\namira: kept: verifying\namira: kept: copying\n$/,
  )
  expect((await ext(["list"])).io.out).toContain("gone 1.0.0 (local copy)")
})

test("ext update names the scope a package is in, and the other scope's packages it did not update", async () => {
  await ext(["install", makePackage("mine", "1.0.0", "m")])
  await ext(["install", "--project", makePackage("theirs", "1.0.0", "t")])
  const user = await ext(["update", "theirs"])
  expect(user.code).toBe(1)
  expect(user.io.err).toBe(
    "amira: theirs is not installed in the user scope; it is in the project scope (use --project)\n",
  )
  const project = await ext(["update", "--project", "mine"])
  expect(project.io.err).toContain("it is in the user scope (leave out --project)")
  expect((await ext(["update", "nowhere", "theirs"])).io.err).toBe(
    "amira: nowhere is not installed in the user scope\namira: theirs is not installed in the user scope; it is in the project scope (use --project)\n",
  )
  // A broken lock file in the other scope does not stop an update of this one.
  const projectLock = path.join(cwd, ".amira", "packages.lock")
  const saved = await Bun.file(projectLock).text()
  writeFileSync(projectLock, "{ not json")
  const broken = await ext(["update", "mine"])
  expect(broken.code).toBe(0)
  expect(broken.io.out).toBe("mine is up to date (1.0.0 (local copy))\n1 up to date\n")
  writeFileSync(projectLock, saved)
  const all = await ext(["update"])
  expect(all.code).toBe(0)
  expect(all.io.out).toBe("mine is up to date (1.0.0 (local copy))\n1 up to date\n")
  expect(all.io.err).toBe(
    "amira: the project scope's packages (theirs) are updated with amira ext update --project\namira: mine: verifying\namira: mine: copying\n",
  )
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
