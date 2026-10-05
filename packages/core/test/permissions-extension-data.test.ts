import { afterEach, expect, spyOn, test } from "bun:test"
import { execSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ToolDefinition } from "@amira/api"
import { extensionDataContainment, extensionDataOwner } from "../src/extension-data.ts"
import { type PermissionRule, Permissions } from "../src/permissions/policy.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

type Writer = Pick<ToolDefinition, "name" | "traits" | "getWrittenPaths" | "shellKind">
const writer: Writer = {
  name: "state_writer",
  traits: { writesFiles: "paths" },
  getWrittenPaths: (args) => args.paths as string[],
}
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-owned-data-"))
  dirs.push(cwd)
  const home = path.join(cwd, "custom-home")
  const owner = extensionDataOwner(home, "@scope/owner")
  const other = extensionDataOwner(home, "@scope/other")
  const own = path.join(owner.dataDir, "state.json")
  const policy = new Permissions({ protect: { amiraHome: home } })
  const check = (paths: string[], tool = writer) => policy.check(tool, { paths }, cwd, owner)
  return { cwd, home, owner, other, own, policy, check }
}

for (const mode of [undefined, "auto", "edits"] as const) {
  test(`all owned paths bypass protected approval (${mode ?? "default"})`, async () => {
    const { cwd, owner, own } = fixture()
    const policy = new Permissions({ protect: { amiraHome: owner.home }, ...(mode ? { mode } : {}) })
    const paths = [own, path.join(owner.dataDir, "missing", "subtree", "cache.json")]
    expect((await policy.check(writer, { paths }, cwd)).decision).toBe("ask")
    expect((await policy.check(writer, { paths }, cwd, owner)).decision).toBe("allow")
    expect(
      (await policy.check(writer, { paths: paths.map((p) => path.relative(cwd, p)) }, cwd, owner)).decision,
    ).toBe("allow")
    expect(extensionDataContainment(owner, cwd, owner.dataDir)).toBe("inside")
  })
}

test("owned data still protects Git metadata, configured hooks and nested Amira settings", async () => {
  const { cwd, owner, own, check } = fixture()
  const hooks = path.join(owner.dataDir, "custom-hooks")
  mkdirSync(path.join(cwd, ".git"))
  writeFileSync(path.join(cwd, ".git", "config"), `[core]\n hooksPath = ${hooks.replaceAll("\\", "/")}\n`)
  for (const target of [
    path.join(owner.dataDir, ".git", "hooks", "pre-commit"),
    path.join(owner.dataDir, ".git", "config"),
    path.join(owner.dataDir, ".gitmodules"),
    path.join(hooks, "pre-commit"),
    path.join(owner.dataDir, ".amira", "settings.json"),
    path.join(owner.dataDir, ".amira", "settings.local.json"),
  ]) {
    expect((await check([target])).decision, target).toBe("ask")
    expect((await check([own, target])).decision, target).toBe("ask")
  }
  expect((await check([own])).decision).toBe("allow")
})

test("the default .amira home is exempted only above the data root", async () => {
  const { cwd } = fixture()
  const owner = extensionDataOwner(path.join(cwd, ".amira"), "default-home")
  const policy = new Permissions({ protect: { amiraHome: owner.home } })
  for (const [suffix, decision] of [
    ["state.json", "allow"],
    [".amira/settings.json", "ask"],
    [".git/hooks/pre-commit", "ask"],
  ] as const) {
    expect(
      (await policy.check(writer, { paths: [path.join(owner.dataDir, suffix)] }, cwd, owner)).decision,
    ).toBe(decision)
  }
})

test("other extension data, home files, sibling prefixes and .. escapes ask", async () => {
  const { home, owner, other, own, check } = fixture()
  for (const target of [
    path.join(other.dataDir, "state.json"),
    path.join(home, "settings.json"),
    path.join(home, "auth.json"),
    path.join(home, "packages", "index.ts"),
    path.join(home, "packages.lock"),
    `${owner.dataDir}-extra${path.sep}state.json`,
    `${owner.dataDir}${path.sep}..${path.sep}..${path.sep}settings.json`,
  ]) {
    expect((await check([target])).decision).toBe("ask")
    expect((await check([own, target])).decision).toBe("ask")
  }
})

test("the host's captured home is protected even without explicit ProtectOptions", async () => {
  const { home, cwd, owner } = fixture()
  expect(
    (await new Permissions().check(writer, { paths: [path.join(home, "settings.json")] }, cwd, owner))
      .decision,
  ).toBe("ask")
})

test("nonqualifying writers still protect the captured custom home without explicit options", async () => {
  const { cwd, home, owner, other, own } = fixture()
  const policy = new Permissions()
  const tools: Writer[] = [
    { ...writer, traits: { writesFiles: true } },
    { ...writer, name: "write", traits: undefined },
  ]
  for (const tool of tools) {
    for (const target of [own, path.join(other.dataDir, "state.json"), path.join(home, "settings.json")]) {
      expect((await policy.check(tool, { paths: [target], path: target }, cwd, owner)).decision).toBe("ask")
    }
  }
})

test("mixed reports receive no partial exemption, but outside ordinary writes are not sandboxed", async () => {
  const { cwd, own, check } = fixture()
  const outside = path.join(cwd, "user-file.txt")
  expect((await check([own, outside])).decision).toBe("ask")
  expect((await check([outside])).decision).toBe("allow")
})

test("plan denies before evaluating even perfectly contained reports", async () => {
  const { cwd, owner, own } = fixture()
  let reports = 0
  const tool: Writer = {
    ...writer,
    getWrittenPaths: () => {
      reports++
      return [own]
    },
  }
  const result = await new Permissions({ mode: "plan" }).check(tool, {}, cwd, owner)
  expect(result.decision).toBe("deny")
  expect(result.cause).toBe("mode")
  expect(reports).toBe(0)
})

test("core and unowned tools get no exemption; writesFiles true is not the paths contract", async () => {
  const { cwd, owner, own, policy, check } = fixture()
  const definition: ToolDefinition = {
    ...writer,
    description: "",
    parameters: { type: "object" },
    execute: async () => ({ content: [] }),
  }
  const tools = new ToolRegistry()
  tools.register(definition, "core", owner)
  const registered = tools.getRegistration(writer.name)!
  expect(registered.dataOwner).toBeUndefined()
  expect((await policy.check(registered.tool, { paths: [own] }, cwd, registered.dataOwner)).decision).toBe(
    "ask",
  )
  expect((await policy.check(writer, { paths: [own] }, cwd)).decision).toBe("ask")
  expect((await check([own], { ...writer, traits: { writesFiles: true } })).decision).toBe("ask")
})

test("missing, throwing and malformed write reports ask; an empty valid report remains no writes", async () => {
  const { cwd, owner, policy, check } = fixture()
  const missing: Writer = { name: writer.name, traits: writer.traits }
  const throwing: Writer = {
    ...writer,
    getWrittenPaths: () => {
      throw new Error("cannot report")
    },
  }
  for (const tool of [missing, throwing]) {
    expect((await policy.check(tool, {}, cwd, owner)).decision).toBe("ask")
  }
  for (const malformed of [null, {}, "state.json", [""], [42], [null]]) {
    expect((await policy.check(writer, { paths: malformed }, cwd, owner)).decision).toBe("ask")
  }
  expect((await check([])).decision).toBe("allow")
})

test("builtin argument union prevents hiding another extension's data in an empty or unrelated report", async () => {
  const { cwd, other, own, owner, policy } = fixture()
  const tool = { ...writer, name: "write" }
  const target = path.join(other.dataDir, "state.json")
  for (const paths of [[], [own]]) {
    expect((await policy.check(tool, { path: target, paths }, cwd, owner)).decision).toBe("ask")
  }
  expect((await policy.check(tool, { path: own, paths: [] }, cwd, owner)).decision).toBe("allow")
})

test("the exemption preserves shell ask/deny rules and edits-mode shell approval", async () => {
  const { cwd, owner, own } = fixture()
  const tool: Writer = { ...writer, traits: { writesFiles: "paths", shell: "bash" } }
  const args = { paths: [own], command: "git push origin" }
  for (const decision of ["ask", "deny"] as const) {
    const rule: PermissionRule = {
      command: ["git", "push"],
      decision,
      source: { scope: "user", file: "settings.json" },
    }
    const result = await new Permissions({ rules: [rule] }).check(tool, args, cwd, owner)
    expect(result.decision).toBe(decision)
    expect(result.cause).toBe("rule")
  }
  const result = await new Permissions({ mode: "edits" }).check(tool, args, cwd, owner)
  expect(result.decision).toBe("ask")
  expect(result.cause).toBe("mode")
})

test("invalid paths, ENOTDIR and exhausted missing-prefix traversal ask", async () => {
  const { owner, own, check } = fixture()
  writeFileSync(own, "state")
  for (const target of [
    `${own}${path.sep}child`,
    path.join(owner.dataDir, "bad\u0000name"),
    path.join(owner.dataDir, ...Array.from({ length: 130 }, () => "missing"), "state.json"),
  ]) {
    expect((await check([target])).decision).toBe("ask")
  }
})

test("an owner directory replaced by a file cannot establish ownership", async () => {
  const { cwd, owner, check } = fixture()
  rmSync(owner.dataDir, { recursive: true })
  writeFileSync(owner.dataDir, "not a directory")
  expect(extensionDataContainment(owner, cwd, owner.dataDir)).toBe("unknown")
  expect((await check([owner.dataDir])).decision).toBe("ask")
})

for (const code of ["EACCES", "EPERM", "ENOTDIR", "ELOOP"]) {
  test(`native resolution failure ${code} asks instead of guessing an ancestor`, async () => {
    const { cwd, owner, own, check } = fixture()
    const resolve = spyOn(realpathSync, "native").mockImplementation(() => {
      throw Object.assign(new Error("cannot resolve"), { code })
    })
    try {
      expect(extensionDataContainment(owner, cwd, own)).toBe("unknown")
      expect((await check([own])).decision).toBe("ask")
    } finally {
      resolve.mockRestore()
    }
  })
}

function caseSensitiveFilesystem(): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-owned-case-probe-"))
  try {
    mkdirSync(path.join(dir, "lower"))
    return !existsSync(path.join(dir, "LOWER"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const posixCaseSensitive = process.platform !== "win32" && caseSensitiveFilesystem()
test.skipIf(!posixCaseSensitive)("POSIX case-only sibling names are not ownership aliases", async () => {
  const { cwd, owner } = fixture()
  const sibling = path.join(path.dirname(owner.dataDir), path.basename(owner.dataDir).toUpperCase())
  mkdirSync(sibling)
  expect(extensionDataContainment(owner, cwd, path.join(sibling, "state.json"))).toBe("outside")
})

/** Probe without swallowing test failures: unsupported link creation yields visible skipped tests. */
function canLink(type: "dir" | "junction"): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-owned-link-probe-"))
  try {
    symlinkSync(dir, path.join(dir, "link"), type)
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const directoryLinks = canLink(process.platform === "win32" ? "junction" : "dir")
const symbolicLinks = canLink("dir")
const linkType = process.platform === "win32" ? "junction" : "dir"

test.skipIf(!directoryLinks)("an unrelated .amira alias into owned data still asks", async () => {
  const { cwd, owner, check } = fixture()
  const alias = path.join(cwd, ".amira")
  symlinkSync(owner.dataDir, alias, linkType)
  const target = path.join(alias, "settings.json")
  expect(extensionDataContainment(owner, cwd, target)).toBe("inside")
  expect((await check([target])).decision).toBe("ask")
  const ordinaryAlias = path.join(cwd, "ordinary-alias")
  symlinkSync(owner.dataDir, ordinaryAlias, linkType)
  expect((await check([path.join(ordinaryAlias, "state.json")])).decision).toBe("allow")
})

test.skipIf(!directoryLinks)("native symlink/junction escapes ask, including missing children", async () => {
  const { cwd, owner, other, home, check } = fixture()
  for (const [name, target] of [
    ["other", other.dataDir],
    ["home", home],
  ] as const) {
    const link = path.join(owner.dataDir, name)
    symlinkSync(target, link, linkType)
    const reported = path.join(link, "missing", "state.json")
    expect(extensionDataContainment(owner, cwd, reported)).toBe("outside")
    expect((await check([reported])).decision).toBe("ask")
  }
  const inside = path.join(owner.dataDir, "inside")
  mkdirSync(inside)
  const link = path.join(owner.dataDir, "local")
  symlinkSync(inside, link, linkType)
  expect((await check([path.join(link, "missing", "state.json")])).decision).toBe("allow")
})

test.skipIf(!symbolicLinks || process.platform === "win32")(
  "symlink/.. traversal cannot hide an escape through normalization",
  async () => {
    const { cwd, owner, check } = fixture()
    const outside = path.join(cwd, "outside")
    mkdirSync(path.join(outside, "child"), { recursive: true })
    const target = path.join(outside, "state.json")
    writeFileSync(target, "outside state")
    const link = path.join(owner.dataDir, "link")
    symlinkSync(path.join(outside, "child"), link, "dir")
    const reported = `${link}/../state.json`
    expect(realpathSync.native(reported)).toBe(realpathSync.native(target))
    expect(extensionDataContainment(owner, cwd, reported)).toBe("unknown")
    expect((await check([reported])).decision).toBe("ask")
  },
)

test.skipIf(!symbolicLinks)(
  "dangling links and link loops are unknown, not nonexistent suffixes",
  async () => {
    const { cwd, owner, check } = fixture()
    const dangling = path.join(owner.dataDir, "dangling")
    symlinkSync(path.join(owner.dataDir, "absent-target"), dangling, "dir")
    const loop = path.join(owner.dataDir, "loop")
    symlinkSync(loop, loop, "dir")
    for (const target of [dangling, path.join(dangling, "child"), path.join(loop, "child")]) {
      expect(extensionDataContainment(owner, cwd, target)).toBe("unknown")
      expect((await check([target])).decision).toBe("ask")
    }
  },
)

for (const redirected of ["owner", "namespace"] as const) {
  test.skipIf(!directoryLinks)(
    `redirected ${redirected} roots cannot redefine extension ownership`,
    async () => {
      const { cwd, home, owner, other, check } = fixture()
      const redirectedRoot = redirected === "owner" ? owner.dataDir : path.join(home, "extension-data")
      const destination = redirected === "owner" ? other.dataDir : path.join(home, "settings")
      mkdirSync(destination, { recursive: true })
      rmSync(redirectedRoot, { recursive: true, force: true })
      symlinkSync(destination, redirectedRoot, linkType)
      const reported = path.join(owner.dataDir, "state.json")
      expect(extensionDataContainment(owner, cwd, reported)).toBe("unknown")
      expect((await check([reported])).decision).toBe("ask")
      expect(() => extensionDataOwner(home, "@scope/owner")).toThrow("safely resolve")
    },
  )
}

test.skipIf(!directoryLinks)(
  "a legitimate symlinked Amira home is canonicalized before anchoring",
  async () => {
    const { cwd, home } = fixture()
    const alias = path.join(cwd, "home-alias")
    symlinkSync(home, alias, linkType)
    const owner = extensionDataOwner(alias, "linked-home")
    expect(extensionDataContainment(owner, cwd, path.join(owner.dataDir, "new", "state.json"))).toBe("inside")
    const policy = new Permissions({ protect: { amiraHome: alias } })
    const other = extensionDataOwner(home, "other-linked-home")
    for (const target of [
      path.join(home, "settings.json"),
      path.join(alias, "settings.json"),
      path.join(other.dataDir, "state.json"),
    ]) {
      expect((await policy.check(writer, { paths: [target] }, cwd, owner)).decision).toBe("ask")
      expect((await policy.check(writer, { paths: [target] }, cwd)).decision).toBe("ask")
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "native Windows case and extended-drive aliases resolve inside",
  async () => {
    const { cwd, owner, own, check } = fixture()
    writeFileSync(own, "state")
    expect((await check([own.toUpperCase()])).decision).toBe("allow")
    const extended = own.startsWith("\\\\") ? `\\\\?\\UNC\\${own.slice(2)}` : `\\\\?\\${own}`
    expect(extensionDataContainment(owner, cwd, extended)).toBe("inside")
    expect((await check([extended])).decision).toBe("allow")
    // Reports use the same MSYS drive and separator semantics as the built-in file tools.
    const msys = own
      .replace(/^([a-z]):/i, (_, drive: string) => `/${drive.toLowerCase()}`)
      .replaceAll("\\", "/")
    expect((await check([msys])).decision).toBe("allow")
    const tmpAlias = `/tmp/${path.relative(os.tmpdir(), own).replaceAll("\\", "/")}`
    expect((await check([tmpAlias])).decision).toBe("allow")
  },
)

function shortName(dir: string): string {
  return execSync(`for %I in ("${dir}") do @echo %~sI`, {
    encoding: "utf8",
    shell: "cmd.exe",
  }).trim()
}

function hasShortNames(): boolean {
  if (process.platform !== "win32") return false
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-owned-short-name-probe-"))
  try {
    return shortName(dir).includes("~")
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test.skipIf(!hasShortNames())("native Windows 8.3 aliases expand before ownership comparison", async () => {
  const { cwd, owner, check } = fixture()
  const alias = path.join(shortName(owner.dataDir), "missing", "state.json")
  expect(extensionDataContainment(owner, cwd, alias)).toBe("inside")
  expect((await check([alias])).decision).toBe("allow")
  const defaultOwner = extensionDataOwner(path.join(cwd, ".amira"), "short-default-home")
  const shortRoot = path.join(
    path.dirname(defaultOwner.dataDir),
    path.basename(shortName(defaultOwner.dataDir)),
  )
  const target = path.join(shortRoot, "state.json")
  const policy = new Permissions({ protect: { amiraHome: defaultOwner.home } })
  expect((await policy.check(writer, { paths: [target] }, cwd, defaultOwner)).decision).toBe("allow")
})

// A real writable share is required: POSIX path simulation cannot verify UNC filesystem identity.
const uncBase = process.env.AMIRA_LIVE_UNC_TEST_DIR
const nativeUnc = process.platform === "win32" && uncBase?.startsWith("\\\\")
test.skipIf(!nativeUnc)("native UNC and extended-UNC names use server/share roots", () => {
  const home = mkdtempSync(path.join(uncBase!, "amira-owned-unc-"))
  dirs.push(home)
  const owner = extensionDataOwner(home, "unc-owner")
  const own = path.join(owner.dataDir, "missing", "state.json")
  const extended = `\\\\?\\UNC\\${own.slice(2)}`
  expect(extensionDataContainment(owner, home, own)).toBe("inside")
  expect(extensionDataContainment(owner, home, extended)).toBe("inside")
  expect(extensionDataContainment(owner, home, path.join(os.tmpdir(), "outside-unc-home.json"))).toBe(
    "outside",
  )
})

test.skipIf(process.platform !== "win32")(
  "Windows streams, device namespaces and dot/space aliases ask",
  async () => {
    const { own, owner, check } = fixture()
    for (const target of [
      `${own}:stream`,
      `${own}.`,
      `${own} `,
      path.join(owner.dataDir, "CON.txt"),
      `\\\\.\\${own}`,
      `\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\state.json`,
      "Z:drive-relative.json",
      "\\\\incomplete-server",
    ]) {
      expect((await check([target])).decision).toBe("ask")
    }
  },
)
