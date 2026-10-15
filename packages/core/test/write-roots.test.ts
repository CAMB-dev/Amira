import { afterEach, expect, test } from "bun:test"
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { type ToolDefinition, textResult } from "@amira/api"
import { applyPatchTool, editTool, writeTool } from "../../../extensions/builtin-tools/src/index.ts"
import { Agent, type AgentOptions } from "../src/agent.ts"
import { Permissions } from "../src/permissions/policy.ts"
import { intersectWriteRoots, validateWriteRoots, WriteRootPolicy } from "../src/permissions/write-roots.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function fixture() {
  const cwd = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "amira-write-roots-")))
  const root = path.join(cwd, "allowed")
  mkdirSync(root)
  cleanups.push(() => rmSync(cwd, { force: true, recursive: true }))
  return { cwd, root }
}
function setup(
  cwd: string,
  roots: readonly string[] | undefined,
  name: string,
  args: Record<string, unknown>,
  options: Partial<AgentOptions> = {},
) {
  const mock = createMockDialect([{ toolCalls: [{ name, args, id: "call" }] }, { text: "done" }])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const tree = new AgentTree({ ai, sections: () => [] })
  const agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd,
    writeRoots: roots,
    sections: [],
    tree,
    ...options,
  })
  cleanups.push(() => agent.dispose())
  return { agent, mock, tree }
}
function result(agent: Agent) {
  return agent.messages.find((m) => m.role === "toolResult")
}
function writer(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "writer",
    description: "test writer",
    parameters: { type: "object" },
    traits: { writesFiles: "paths" },
    getWrittenPaths: (args) => [String(args.path)],
    execute: async () => textResult("executed"),
    ...overrides,
  }
}

function supportsLinks(): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-links-probe-"))
  try {
    mkdirSync(path.join(dir, "target"))
    writeFileSync(path.join(dir, "file"), "probe")
    linkSync(path.join(dir, "file"), path.join(dir, "hard"))
    symlinkSync(
      path.join(dir, "target"),
      path.join(dir, "link"),
      process.platform === "win32" ? "junction" : "dir",
    )
    return true
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EINVAL"].includes(String(error.code))
    )
      return false
    throw error
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
const linksSupported = supportsLinks()

test("bounded built-in writes work without rewind, including missing descendant directories", async () => {
  const { cwd, root } = fixture()
  const dest = path.join(root, "new", "file.txt")
  const { agent } = setup(cwd, [root], "write", { path: dest, content: "hello" })
  agent.tools.register(writeTool, "test")
  await agent.prompt("go")
  expect(readFileSync(dest, "utf8")).toBe("hello")
  expect(result(agent)?.isError).toBe(false)
})

test("absolute and sibling-prefix escapes, empty roots, malformed and throwing reports deny before approval", async () => {
  const { cwd, root } = fixture()
  for (const item of [
    { roots: [root], paths: [path.join(cwd, "outside")] },
    { roots: [root], paths: [path.join(`${root}-sibling`, "x")] },
    { roots: [], paths: [path.join(root, "x")] },
    { roots: [root], paths: [] },
    { roots: [root], paths: undefined },
  ]) {
    let executed = 0
    let approved = 0
    const { agent } = setup(
      cwd,
      item.roots,
      "writer",
      {},
      {
        approve: async () => {
          approved++
          return { approved: true }
        },
      },
    )
    agent.interceptors.add("tool.call.before", () => ({ action: "ask", reason: "ask" }))
    agent.tools.register(
      writer({
        getWrittenPaths: () => {
          if (!item.paths) throw new Error("bad report")
          return item.paths
        },
        execute: async () => {
          executed++
          return textResult("bad")
        },
      }),
      "test",
    )
    await agent.prompt("go")
    expect(result(agent)?.isError).toBe(true)
    expect(executed).toBe(0)
    expect(approved).toBe(0)
  }
})

test("a known writer without any report cannot execute under a ceiling", async () => {
  const { cwd, root } = fixture()
  let executed = false
  const { agent } = setup(cwd, [root], "writer", {})
  agent.tools.register(
    writer({
      getWrittenPaths: undefined,
      traits: { writesFiles: true },
      execute: async () => {
        executed = true
        return textResult("bad")
      },
    }),
    "test",
  )
  await agent.prompt("go")
  expect(executed).toBe(false)
})

test("forged built-in overrides cannot subtract built-in paths from their report", async () => {
  const { cwd, root } = fixture()
  for (const [name, args] of [
    ["write", { path: path.join(cwd, "outside") }],
    ["edit", { path: path.join(cwd, "outside") }],
    [
      "apply_patch",
      {
        patch: `*** Begin Patch\n*** Update File: ${path.join(root, "x")}\n*** Move to: ${path.join(cwd, "outside")}\n@@\n-a\n+b\n*** End Patch`,
      },
    ],
  ] as const) {
    let executed = false
    const { agent } = setup(cwd, [root], name, args)
    agent.tools.register(
      writer({
        name,
        traits: { readOnly: true, writesFiles: false },
        getWrittenPaths: () => [path.join(root, "safe")],
        execute: async () => {
          executed = true
          return textResult("bad")
        },
      }),
      "test",
    )
    await agent.prompt("go")
    expect(executed).toBe(false)
  }
})

test("all extension and built-in report paths are checked; final interceptor arguments are authoritative", async () => {
  const { cwd, root } = fixture()
  for (const rewrite of [false, true]) {
    let executed = false
    const { agent } = setup(cwd, [root], "write", { path: path.join(root, "safe") })
    if (rewrite)
      agent.interceptors.add("tool.call.before", (value) => ({
        action: "modify",
        value: { ...value, args: { path: path.join(cwd, "outside") } },
      }))
    agent.tools.register(
      writer({
        name: "write",
        getWrittenPaths: () => [path.join(root, "safe"), ...(rewrite ? [] : [path.join(cwd, "outside")])],
        execute: async () => {
          executed = true
          return textResult("bad")
        },
      }),
      "test",
    )
    await agent.prompt("go")
    expect(executed).toBe(false)
  }
})

test("mixed patch moves and deletes are checked before any mutation", async () => {
  const { cwd, root } = fixture()
  const inside = path.join(root, "x")
  const outside = path.join(cwd, "outside")
  writeFileSync(inside, "a\n")
  writeFileSync(outside, "a\n")
  for (const patch of [
    `*** Begin Patch\n*** Delete File: ${inside}\n*** Delete File: ${outside}\n*** End Patch`,
    `*** Begin Patch\n*** Update File: ${inside}\n*** Move to: ${outside}\n@@\n-a\n+b\n*** End Patch`,
  ]) {
    const { agent } = setup(cwd, [root], "apply_patch", { patch })
    agent.tools.register(applyPatchTool, "test")
    await agent.prompt("go")
    expect(readFileSync(inside, "utf8")).toBe("a\n")
    expect(readFileSync(outside, "utf8")).toBe("a\n")
    expect(result(agent)?.isError).toBe(true)
  }
})

test("mutation hooks enforce additional paths even with rewind absent", async () => {
  const { cwd, root } = fixture()
  let mutated = false
  const { agent } = setup(cwd, [root], "writer", { path: path.join(root, "safe") })
  agent.tools.register(
    writer({
      traits: { writesFiles: "paths", usesMutationHook: true },
      execute: async (_args, ctx) => {
        await ctx.mutateFiles!([{ path: path.join(cwd, "outside"), after: Buffer.from("bad") }], async () => {
          mutated = true
        })
        return textResult("done")
      },
    }),
    "test",
  )
  await agent.prompt("go")
  expect(mutated).toBe(false)
  expect(result(agent)?.isError).toBe(true)
})

test("in-root writes still obey plan mode and protected-path approvals", async () => {
  const { cwd, root } = fixture()
  for (const mode of ["plan", "auto"] as const) {
    const protectedRoot = path.join(root, ".amira")
    mkdirSync(protectedRoot, { recursive: true })
    const dest = path.join(protectedRoot, "settings.json")
    let approvals = 0
    const permissions = new Permissions({
      mode,
      approver: async () => {
        approvals++
        return { approved: false }
      },
    })
    const { agent } = setup(cwd, [root], "write", { path: dest, content: "bad" }, { permissions })
    agent.tools.register(writeTool, "test")
    await agent.prompt("go")
    expect(existsSync(dest)).toBe(false)
    expect(approvals).toBe(mode === "auto" ? 1 : 0)
  }
})

test.skipIf(!linksSupported)(
  "symlinks, junction escapes, hard links and dangling links are refused",
  async () => {
    const { cwd, root } = fixture()
    const outside = path.join(cwd, "outside")
    mkdirSync(outside)
    symlinkSync(outside, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir")
    writeFileSync(path.join(outside, "file"), "original")
    linkSync(path.join(outside, "file"), path.join(root, "hard"))
    symlinkSync(
      path.join(cwd, "missing"),
      path.join(root, "dangling"),
      process.platform === "win32" ? "junction" : "dir",
    )
    const policy = new WriteRootPolicy(validateWriteRoots([root])!)
    for (const name of ["link/file", "link/../safe", "hard", "dangling/file"])
      expect(() => policy.check(root, [name])).toThrow()
  },
)

test("directory replacement during approval denies the already approved call", async () => {
  const { cwd, root } = fixture()
  const { agent } = setup(
    cwd,
    [root],
    "write",
    { path: path.join(root, "x"), content: "bad" },
    {
      approve: async () => {
        renameSync(root, `${root}-old`)
        mkdirSync(root)
        return { approved: true }
      },
    },
  )
  agent.interceptors.add("tool.call.before", () => ({ action: "ask", reason: "pause" }))
  agent.tools.register(writeTool, "test")
  await agent.prompt("go")
  expect(existsSync(path.join(root, "x"))).toBe(false)
})

test("root intersections preserve omitted, empty, nested and disjoint policies", () => {
  const { cwd, root } = fixture()
  const nested = path.join(root, "nested")
  expect(intersectWriteRoots([root], undefined)).toEqual([root])
  expect(intersectWriteRoots([root], [cwd])).toEqual([root])
  expect(intersectWriteRoots([root], [nested])).toEqual([nested])
  expect(intersectWriteRoots([root], [path.join(cwd, "other")])).toEqual([])
  expect(intersectWriteRoots([], [root])).toEqual([])
  expect(intersectWriteRoots([root], [])).toEqual([])
  expect(() => validateWriteRoots(["relative"])).toThrow()
})

test("ordinary and private descendants cannot widen inherited roots, including extra tools", async () => {
  const { cwd, root } = fixture()
  for (const ephemeral of [false, true]) {
    let executed = false
    const { agent, tree } = setup(cwd, [root], "writer", { path: path.join(cwd, "outside") })
    const child = tree.spawn(agent, {
      prompt: "go",
      ephemeral,
      maxTurns: 1,
      writeRoots: [cwd],
      extraTools: [
        writer({
          execute: async () => {
            executed = true
            return textResult("bad")
          },
        }),
      ],
    })
    await child.result()
    expect(executed).toBe(false)
  }
})

test("disabled writers do not execute and reads and mock shell tools are not destination-sandboxed", async () => {
  const { cwd, root } = fixture()
  for (const disabled of [false, true]) {
    let executed = false
    const { agent } = setup(cwd, [], "read", {})
    agent.tools.register(
      writer({
        name: "read",
        traits: { readOnly: true },
        getWrittenPaths: undefined,
        execute: async () => {
          executed = true
          return textResult("read outside")
        },
      }),
      "test",
    )
    if (disabled) agent.tools.setDisabled(["read"])
    await agent.prompt("go")
    expect(executed).toBe(!disabled)
  }
  const { agent } = setup(cwd, [root], "bash", { command: "echo mock" })
  let executed = false
  agent.tools.register(
    writer({
      name: "bash",
      traits: { shell: "bash" },
      getWrittenPaths: undefined,
      execute: async () => {
        executed = true
        return textResult("mock shell only")
      },
    }),
    "test",
  )
  await agent.prompt("go")
  expect(executed).toBe(true)
})

test.skipIf(process.platform !== "win32")(
  "ambiguous Windows aliases, devices, ADS and drive-relative paths fail closed",
  () => {
    const { root } = fixture()
    const policy = new WriteRootPolicy(validateWriteRoots([root])!)
    for (const name of [
      "file::$DATA",
      "file.",
      "file ",
      "NUL",
      "CON.txt",
      "CON .txt",
      "CONIN$",
      "CONOUT$",
      "CLOCK$",
      "C:relative",
      "\\\\.\\C:\\file",
      "\\??\\C:\\file",
    ])
      expect(() => policy.check(root, [name])).toThrow()
  },
)

test("case-only directory names respect filesystem case sensitivity", () => {
  const { cwd, root } = fixture()
  const alternate = path.join(cwd, "Allowed")
  const policy = new WriteRootPolicy(validateWriteRoots([root])!)
  if (existsSync(alternate)) {
    expect(realpathSync.native(alternate)).toBe(root)
    expect(() => policy.check(cwd, ["Allowed/file"])).not.toThrow()
  } else {
    mkdirSync(alternate)
    expect(() => policy.check(cwd, ["Allowed/file"])).toThrow()
  }
})

test("malformed reporters fail closed and do not reach executors", async () => {
  const { cwd, root } = fixture()
  for (const report of ["null", '"path"', "[1]", '[""]']) {
    let executed = false
    const { agent } = setup(cwd, [root], "writer", {})
    agent.tools.register(
      writer({
        getWrittenPaths: () => JSON.parse(report),
        execute: async () => {
          executed = true
          return textResult("bad")
        },
      }),
      "test",
    )
    await agent.prompt("go")
    expect(executed).toBe(false)
    expect(result(agent)?.isError).toBe(true)
  }
})

test.skipIf(!linksSupported)("hard-link edits cannot change an outside inode", async () => {
  const { cwd, root } = fixture()
  const outside = path.join(cwd, "outside")
  const inside = path.join(root, "hard")
  writeFileSync(outside, "before")
  linkSync(outside, inside)
  const { agent } = setup(cwd, [root], "edit", { path: inside, old_string: "before", new_string: "after" })
  agent.tools.register(editTool, "test")
  await agent.prompt("go")
  expect(readFileSync(outside, "utf8")).toBe("before")
  expect(result(agent)?.isError).toBe(true)
})

test("mutation boundary rechecks directory identities after executor awaits", async () => {
  const { cwd, root } = fixture()
  let mutated = false
  const { agent } = setup(cwd, [root], "writer", { path: path.join(root, "safe") })
  agent.tools.register(
    writer({
      traits: { writesFiles: "paths", usesMutationHook: true },
      execute: async (_args, ctx) => {
        await Promise.resolve()
        renameSync(root, `${root}-old`)
        mkdirSync(root)
        await ctx.mutateFiles!([{ path: path.join(root, "safe"), after: Buffer.from("bad") }], async () => {
          mutated = true
        })
        return textResult("done")
      },
    }),
    "test",
  )
  await agent.prompt("go")
  expect(mutated).toBe(false)
})

test.skipIf(!linksSupported)("resolved in-root symlink ancestors are pinned across approval", async () => {
  const { cwd, root } = fixture()
  const target = path.join(root, "target")
  mkdirSync(target)
  symlinkSync(target, path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir")
  const { agent } = setup(
    cwd,
    [root],
    "write",
    { path: path.join(root, "alias", "new"), content: "bad" },
    {
      approve: async () => {
        renameSync(target, `${target}-old`)
        mkdirSync(target)
        return { approved: true }
      },
    },
  )
  agent.tools.register(writeTool, "test")
  agent.interceptors.add("tool.call.before", () => ({ action: "ask", reason: "pause" }))
  await agent.prompt("go")
  expect(existsSync(path.join(target, "new"))).toBe(false)
})

test.skipIf(process.platform !== "win32")(
  "Windows case, extended and MSYS drive aliases resolve to the same root",
  () => {
    const { root } = fixture()
    const policy = new WriteRootPolicy(validateWriteRoots([root])!)
    const drive = root[0]!.toLowerCase()
    expect(validateWriteRoots([`/${drive}/${root.slice(3).replaceAll("\\", "/")}`])).toEqual([root])
    for (const name of [
      path.join(root.toUpperCase(), "new"),
      `\\\\?\\${root}\\new`,
      `/${drive}/${root.slice(3).replaceAll("\\", "/")}/new`,
    ])
      expect(() => policy.check(root, [name])).not.toThrow()
  },
)

test("narrowed grandchildren inherit execution and persisted ceilings even when requesting wider roots", async () => {
  const { cwd, root } = fixture()
  const narrow = path.join(root, "nested")
  mkdirSync(narrow)
  const mock = createMockDialect([
    { toolCalls: [{ name: "descend", args: {}, id: "descend" }] },
    { toolCalls: [{ name: "writer", args: { path: path.join(root, "outside-narrow") }, id: "write" }] },
    { text: "grand done" },
    { text: "child done" },
  ])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
  })
  const tree = new AgentTree({ ai, sections: () => [] })
  const session = SessionStore.create({ cwd, dir: path.join(cwd, "sessions"), writeRoots: [root] })
  const agent = new Agent({
    ai,
    tree,
    model: ai.model("mock/test"),
    cwd,
    session,
    writeRoots: [root],
    sections: [],
  })
  cleanups.push(() => agent.dispose())
  let executed = false
  let grandId = ""
  const child = tree.spawn(agent, {
    prompt: "child",
    writeRoots: [narrow],
    extraTools: [
      writer({
        name: "descend",
        traits: { readOnly: true },
        getWrittenPaths: undefined,
        execute: async (_args, ctx) => {
          const grand = ctx.session!.spawn!({
            prompt: "grand",
            writeRoots: [cwd],
            extraTools: [
              writer({
                execute: async () => {
                  executed = true
                  return textResult("bad")
                },
              }),
            ],
          })
          grandId = grand.id
          await grand.result()
          return textResult("done")
        },
      }),
    ],
  })
  await child.result()
  expect(executed).toBe(false)
  expect(
    SessionStore.open(path.join(cwd, "sessions", "subagents", `${child.id}.jsonl`)).header.writeRoots,
  ).toEqual([narrow])
  expect(
    SessionStore.open(path.join(cwd, "sessions", "subagents", "subagents", `${grandId}.jsonl`)).header
      .writeRoots,
  ).toEqual([narrow])
})
