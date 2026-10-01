import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type {
  ExtensionAdmin,
  ExtensionProgress,
  ManagedExtension,
  SessionControl,
  UiRequest,
} from "@amira/api"
import { createAi, createMockDialect } from "../../../packages/ai/src/index.ts"
import {
  Agent,
  CommandHost,
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  loadSettings,
  ToolRegistry,
} from "../../../packages/core/src/index.ts"
import {
  createExtensionAdmin,
  DEFAULT_INDEX_URL,
  packageScope,
  readLock,
} from "../../../packages/packages/src/index.ts"
import { extensionProgressLines, extensionRows, parseExtArgs } from "../src/ext-command.ts"
import commandsExtension from "../src/index.ts"

setDefaultTimeout(60_000)
let dir: string
let home: string
let cwd: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "amira-tui-ext-"))
  home = path.join(dir, "home")
  cwd = path.join(dir, "project")
  mkdirSync(home)
  mkdirSync(cwd)
})
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))

async function git(repo: string, ...args: string[]) {
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  )
  const output = await new Response(child.stderr).text()
  if (await child.exited) throw new Error(output)
}

async function fixture() {
  const repo = path.join(dir, "repo")
  mkdirSync(repo)
  const manifest = (version: string) =>
    writeFileSync(
      path.join(repo, "package.json"),
      JSON.stringify({ name: "fixture", version, type: "module", description: "Local fixture", amira: {} }),
    )
  manifest("1.0.0")
  writeFileSync(path.join(repo, "index.ts"), "export default () => {}\n")
  await git(repo, "init", "-q", "-b", "main")
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", "fixture one")
  const indexFile = path.join(dir, "index.json")
  const index = (version = "1.0.0") =>
    writeFileSync(
      indexFile,
      JSON.stringify({
        schemaVersion: 1,
        extensions: [
          {
            name: "fixture",
            version,
            description: "Local fixture",
            source: { git: pathToFileURL(repo).href },
          },
          {
            name: "available",
            version: "1.0.0",
            description: "Other fixture",
            source: { git: pathToFileURL(repo).href },
          },
        ],
      }),
    )
  index()
  const admin = createExtensionAdmin(
    { home, cwd },
    {
      index: { url: pathToFileURL(indexFile).href },
      fetch: (() => {
        throw new Error("network forbidden")
      }) as unknown as typeof fetch,
    },
  )
  return { admin, repo, manifest, index }
}

async function setup(
  admin: ExtensionAdmin,
  answer: (r: UiRequest) => unknown = () => undefined,
  busy = false,
) {
  const bus = new EventBus()
  const host = new ExtensionHost({
    bus,
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
    cwd,
  })
  await host.load(commandsExtension, "builtin:commands")
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agent = new Agent({ ai, model: ai.model("mock/m"), cwd, bus })
  let reloads = 0
  const control = {
    extensionAdmin: admin,
    info: () => ({ id: agent.sessionId, cwd, busy }),
    reloadExtensions: async () => {
      if (busy) throw new Error("a turn is running; reload after it ends")
      reloads++
      return undefined
    },
  } as unknown as SessionControl
  const commands = new CommandHost({ registry: host.commands, bus, ui: host.ui, control, agent })
  const asked: UiRequest[] = []
  bus.subscribe((e) => {
    if (e.type !== "ui.request") return
    asked.push(e.data)
    const value = answer(e.data)
    if (value === undefined) host.ui.cancel(e.data.requestId)
    else expect(host.ui.respond(e.data.requestId, value)).toBeUndefined()
  })
  const run = (line: string, signal?: AbortSignal) =>
    commands.run(line, { frontend: "tui", ...(signal ? { signal } : {}) })
  return { run, commands, host, asked, reloads: () => reloads }
}

test("/ext parsing validates arity and flags, preserving explicit scope", () => {
  expect(parseExtArgs("")).toEqual({ names: [], scope: "user" })
  expect(parseExtArgs("install fixture --project")).toEqual({
    sub: "install",
    names: ["fixture"],
    scope: "project",
  })
  expect(parseExtArgs("update one two").names).toEqual(["one", "two"])
  expect(parseExtArgs("search local fixture").names.join(" ")).toBe("local fixture")
  for (const args of [
    "nope",
    "constructor",
    "toString",
    "__proto__",
    "install",
    "remove one two",
    "install a --quiet",
    "--project",
    "update --project --project",
    "disable a --project",
    "enable a --project",
    "search a --project",
  ])
    expect(() => parseExtArgs(args)).toThrow()
})

test("installed and available rows have unique scoped labels and details keys", () => {
  const p: ManagedExtension = {
    name: "fixture",
    version: "1.0.0",
    scope: "user",
    enabled: false,
    trusted: true,
    source: "local",
    description: "first\nline",
  }
  const rows = extensionRows(
    [p, { ...p, scope: "project", trusted: false }],
    [
      { name: "fixture", version: "2.0.0", description: "" },
      { name: "available", version: "1.0.0", description: "new\npackage" },
    ],
  )
  expect(new Set(rows.options).size).toBe(3)
  expect(rows.options[0]).toContain("disabled")
  expect(rows.options[1]).toContain("not trusted")
  expect(rows.options[0]).toContain("update available")
  expect(rows.descriptions).toEqual(["first line", "first line", "new package"])
  expect(rows.sections).toEqual([
    { at: 0, title: "Installed", choose: "manage", keys: [{ key: "d", label: "details" }] },
    { at: 2, title: "Available from the index", choose: "install", keys: [{ key: "d", label: "details" }] },
  ])
})

test("/ext local file git install, reinstall, update, disable, enable and remove use the core", async () => {
  const { admin, repo, manifest, index } = await fixture()
  const { run, reloads } = await setup(admin)
  expect((await run("/ext install fixture")).output.join("\n")).toContain(
    "Installed fixture 1.0.0 into user scope. Reload now? (/reload)",
  )
  const lock = () => readLock(packageScope("user", { home, cwd }).lockFile).packages.fixture!
  const first = lock().pinned.commit
  expect(first).toBeTruthy()
  expect((await run("/ext install fixture")).ok).toBe(true)
  expect(lock().pinned.commit).toBe(first)
  expect((await run("/ext disable fixture")).ok).toBe(true)
  expect(loadSettings({ home, cwd }).settings.packages?.disabled).toEqual(["fixture"])
  expect((await run("/ext disable fixture")).output.join("\n")).toContain("already disabled")
  expect((await run("/ext enable fixture")).ok).toBe(true)
  expect(loadSettings({ home, cwd }).settings.packages?.disabled).toBeUndefined()
  manifest("2.0.0")
  index("2.0.0")
  await git(repo, "add", "-A")
  await git(repo, "commit", "-q", "-m", "fixture two")
  expect((await run("/ext update fixture")).output.join("\n")).toContain("Updated fixture to 2.0.0")
  expect(lock().version).toBe("2.0.0")
  expect(lock().pinned.commit).not.toBe(first)
  expect((await run("/ext update")).output.join("\n")).toContain("up to date")
  expect((await run("/ext remove fixture")).ok).toBe(true)
  expect(admin.list()).toEqual([])
  expect(reloads()).toBe(0)
})

test("project installation preserves trust; picker operations retain the highlighted scope", async () => {
  const { admin } = await fixture()
  const direct = await setup(admin, () => undefined, true)
  const project = await direct.run("/ext install fixture --project")
  expect(project.output.join("\n")).toContain("Run /reload after the turn ends")
  expect(project.output.join("\n")).toContain("Amira asks at the next start")
  expect(admin.list()[0]?.trusted).toBe(false)
  expect(loadSettings({ home, cwd }).settings.packages?.trustedProjects).toBeUndefined()
  expect((await direct.run("/reload")).ok).toBe(false)
  expect(direct.reloads()).toBe(0)
  await direct.run("/ext install fixture")
  const picker = await setup(admin, (r) =>
    r.kind === "select"
      ? r.title === "Extensions"
        ? r.options.find((o) => o.includes("· project"))
        : "Remove"
      : r.kind === "confirm"
        ? true
        : undefined,
  )
  expect((await picker.run("/ext")).ok).toBe(true)
  expect(admin.list().map((p) => p.scope)).toEqual(["user"])
  expect(picker.asked.filter((r) => r.kind === "select")[0]).toMatchObject({
    sections: [
      { at: 0, title: "Installed" },
      { at: 2, title: "Available from the index" },
    ],
  })
})

test("available picker chooses user by default or project explicitly, supports details and cancellation", async () => {
  const { admin } = await fixture()
  const picker = await setup(admin, (r) =>
    r.kind === "select" ? (r.title === "Extensions" ? "fixture" : r.options[0]) : undefined,
  )
  expect((await picker.run("/ext")).ok).toBe(true)
  expect(admin.list()[0]?.scope).toBe("user")
  const details = await setup(admin, (r) =>
    r.kind === "select" ? { option: r.options[0], key: "d" } : undefined,
  )
  expect((await details.run("/ext")).output.join("\n")).toContain("Source:")
  const cancelled = await setup(admin)
  expect((await cancelled.run("/ext")).ok).toBe(true)
  expect(admin.list()).toHaveLength(1)
  const completing = await picker.commands.complete("/ext install ")
  expect(completing.candidates.map((c) => c.value)).toEqual(["install fixture", "install available"])
  expect((await picker.commands.complete("/ext remove ")).candidates[0]?.value).toBe("remove fixture")
  expect((await picker.commands.complete("/ext update --project ")).candidates).toEqual([])
  expect((await picker.run("/ext search local fixture")).output.join("\n")).toContain("Local fixture")
})

test("unknown names, wrong scope, offline errors, and failed update keep packages", async () => {
  const f = await fixture()
  const { run } = await setup(f.admin)
  expect((await run("/ext install unknown")).error).toContain("not in the extensions index")
  expect((await run("/ext remove unknown")).error).toContain("not installed")
  expect((await run("/ext disable unknown")).error).toContain("not installed")
  await run("/ext install fixture --project")
  expect((await run("/ext update fixture")).error).toContain("use --project")
  expect((await run("/ext remove fixture")).error).toContain("use --project")
  const version = f.admin.list()[0]!.version
  rmSync(f.repo, { recursive: true, force: true })
  const failed = await run("/ext update fixture --project")
  expect(failed.output.join("\n")).toContain("update failed, kept")
  expect(f.admin.list()[0]?.version).toBe(version)
  const offline = createExtensionAdmin(
    { home, cwd },
    {
      index: {
        url: "https://fixture.invalid/index.json",
        fetch: (async () => {
          throw new Error("offline fixture")
        }) as unknown as typeof fetch,
      },
    },
  )
  const listing = await setup(offline, (r) =>
    r.kind === "select" ? { option: r.options[0], key: "d" } : undefined,
  )
  expect((await listing.run("/ext search x")).error).toContain("offline fixture")
  expect((await listing.run("/ext")).output.join("\n")).toContain("Index unavailable")
  expect(listing.asked).toHaveLength(1)
})

test("cancelling a core install leaves no files or lock entry, clears panel and permits another operation", async () => {
  const { admin } = await fixture()
  const abort = new AbortController()
  const phases: string[] = []
  const wrapped: ExtensionAdmin = {
    ...admin,
    install: (name, scope, opts) =>
      admin.install(name, scope, {
        ...opts,
        onProgress: (p) => {
          phases.push(p.phase)
          opts.onProgress(p)
          if (p.phase === "extracting") abort.abort()
        },
      }),
  }
  const { run, host } = await setup(wrapped)
  const cancelled = await run("/ext install fixture", abort.signal)
  expect(cancelled.output.join("\n")).toContain("cancelled")
  expect(phases).toContain("extracting")
  expect(admin.list()).toEqual([])
  expect(existsSync(path.join(home, "packages", "fixture"))).toBe(false)
  expect(host.panels.snapshot({ width: 60, now: 0, sessionId: "s1", collapsed: false })).toEqual([])
  expect((await run("/ext search fixture")).ok).toBe(true)
})

test("index fetch cancellation stops mirrors and never falls back to a stale cache", async () => {
  const abort = new AbortController()
  const cacheFile = path.join(home, "cache", "extensions-index.json")
  mkdirSync(path.dirname(cacheFile), { recursive: true })
  writeFileSync(
    cacheFile,
    JSON.stringify({ fetchedAt: 1, url: DEFAULT_INDEX_URL, data: { schemaVersion: 1, extensions: [] } }),
  )
  let fetches = 0
  const fetching = Promise.withResolvers<void>()
  const admin = createExtensionAdmin(
    { home, cwd },
    {
      index: {
        url: DEFAULT_INDEX_URL,
        fetch: ((_url, opts) =>
          new Promise((_resolve, reject) => {
            fetches++
            opts?.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true })
            fetching.resolve()
          })) as typeof fetch,
      },
    },
  )
  const { run } = await setup(admin)
  const pending = run("/ext search fixture", abort.signal)
  await fetching.promise
  abort.abort(new Error("cancelled"))
  expect((await pending).output.join("\n")).toContain("cancelled")
  expect(fetches).toBe(1)
  expect(existsSync(cacheFile)).toBe(true)
})

test("progress uses themed lines and clips 120/60 columns including fetching percentages", () => {
  const progress: ExtensionProgress[] = [
    { name: "fixture", phase: "resolving" },
    { name: "other", phase: "fetching", percent: 42, detail: "a".repeat(150) },
    { name: "third", phase: "extracting" },
    { name: "done", phase: "done" },
    { name: "failed", phase: "failed" },
  ]
  for (const width of [120, 60]) {
    const rows = extensionProgressLines(progress, width)
    expect(rows.every((r) => r.text.length <= width)).toBe(true)
    expect(rows[2]!.text).toContain("fetching 42%")
    expect(rows[4]!.kind).toBe("success")
    expect(rows[5]!.kind).toBe("error")
  }
})
