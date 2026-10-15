import { afterEach, expect, spyOn, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import { type ChildSession, type SpawnOptions, type ToolDefinition, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { OwnedConversationManager } from "../src/owned-conversations.ts"
import { intersectWriteRoots, validateWriteRoots, WriteRootPolicy } from "../src/permissions/write-roots.ts"
import { Child } from "../src/subagents/child.ts"
import { AgentTree } from "../src/subagents.ts"

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function supportsJunctions(): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-inheritance-probe-"))
  try {
    mkdirSync(path.join(dir, "target"))
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
const junctionsSupported = supportsJunctions()

function fixture() {
  const cwd = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "amira-inherited-roots-")))
  const root = path.join(cwd, "A")
  const outside = path.join(cwd, "B")
  mkdirSync(root)
  mkdirSync(outside)
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }))
  return { cwd, root, outside }
}

function replaceWithJunction(root: string, target: string) {
  renameSync(root, `${root}-old`)
  symlinkSync(target, root, process.platform === "win32" ? "junction" : "dir")
}

async function setup(cwd: string, root: string, destination: string, owned: boolean, nested = false) {
  const steps: MockStep[] = [
    ...(nested ? [{ text: "ready" }] : []),
    { toolCalls: [{ name: "writer", args: { path: destination }, id: "write" }] },
    { text: "done" },
  ]
  const mock = createMockDialect(steps)
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const tree = new AgentTree({ ai, sections: () => [] })
  let executions = 0
  let approvals = 0
  const agent = new Agent({
    ai,
    tree,
    model: ai.model("mock/test"),
    cwd,
    writeRoots: [root],
    sections: [],
    fileRewindSettings: { enabled: false },
    approve: async () => {
      approvals++
      return { approved: true }
    },
  })
  const writer: ToolDefinition = {
    name: "writer",
    description: "write a fixture file",
    parameters: { type: "object" },
    traits: { writesFiles: "paths" },
    getWrittenPaths: (args) => [String(args.path)],
    execute: async (args) => {
      executions++
      writeFileSync(String(args.path), "unauthorized")
      return textResult("written")
    },
  }
  agent.tools.register(writer, "fixture")
  cleanups.push(() => agent.dispose())
  let spawn: (opts: SpawnOptions) => ChildSession = (opts) => tree.spawn(agent, opts)
  if (owned) {
    const manager = new OwnedConversationManager({
      ai,
      tools: agent.tools,
      tree,
      home: cwd,
      agent: () => agent,
    })
    cleanups.push(() => manager.drain())
    const handle = await manager.forOwner("fixture").openOrCreate(
      {
        key: "bounded",
        name: "Bounded",
        cwd,
        systemPrompt: "Work inside the inherited roots.",
        callableTools: ["writer"],
        writeRoots: [root],
        descendants: "inherit",
      },
      { askUser: async () => undefined },
    )
    const group = handle.createGroup({ name: "bounded descendants" })
    spawn = (opts) => group.spawn(opts)
  }
  return { mock, writer, spawn, counts: () => ({ executions, approvals }) }
}

async function idle(child: ChildSession) {
  const deadline = Date.now() + 3000
  while (child.state !== "idle") {
    if (Date.now() > deadline) throw new Error("child did not become idle")
    await Bun.sleep(2)
  }
}

function protectedDestination(outside: string): string {
  // A protected destination exercises approval routing too; an ordinary path can hide the
  // widened ceiling behind a parent consultation that never reaches the writer.
  mkdirSync(path.join(outside, ".amira"))
  return path.join(outside, ".amira", "settings.json")
}

test.skipIf(!junctionsSupported)(
  "new parent roots are canonicalized before establishing their policy",
  () => {
    const { root, outside } = fixture()
    replaceWithJunction(root, outside)
    const roots = intersectWriteRoots([root], undefined)
    expect(roots).toEqual([outside])
    expect(Object.isFrozen(roots)).toBe(true)
  },
)

test.skipIf(!junctionsSupported)(
  "narrowing retains the original anchors even for roots outside the intersection",
  () => {
    const { root, outside } = fixture()
    const parent = intersectWriteRoots(undefined, [root, outside])
    const narrowed = intersectWriteRoots(parent, [outside])
    expect(narrowed).toEqual([outside])
    replaceWithJunction(root, outside)
    expect(() => intersectWriteRoots(narrowed, undefined)).toThrow(/write|identity|ENOENT/i)
  },
)

test("validation preserves established roots and their inherited identities", () => {
  const { root, outside } = fixture()
  const parent = intersectWriteRoots(undefined, [root, outside])
  const narrowed = intersectWriteRoots(parent, [outside])
  const validated = validateWriteRoots(narrowed)
  expect(validated).toBe(narrowed)
  renameSync(root, `${root}-old`)
  mkdirSync(root)
  expect(() => intersectWriteRoots(validated, undefined)).toThrow(/write|identity|ENOENT/i)
  expect(() => validateWriteRoots(narrowed)).toThrow(/write|identity|ENOENT/i)
})

test("newly validated roots record their identities before inheritance", () => {
  const { root } = fixture()
  const roots = validateWriteRoots([root])
  renameSync(root, `${root}-old`)
  mkdirSync(root)
  expect(() => intersectWriteRoots(roots, undefined)).toThrow(/write|identity|ENOENT/i)
})

test.skipIf(!junctionsSupported)(
  "actual dispatch rechecks roots after the executor scheduling microtask",
  async () => {
    const { cwd, root, outside } = fixture()
    const f = await setup(cwd, root, path.join(root, "escaped.txt"), false)
    const original = WriteRootPolicy.prototype.check
    let scheduled = false
    const spy = spyOn(WriteRootPolicy.prototype, "check").mockImplementation(function (
      this: WriteRootPolicy,
      ...args
    ) {
      const checked = original.apply(this, args)
      return Object.assign(
        () => {
          checked()
          if (!scheduled) {
            scheduled = true
            queueMicrotask(() => replaceWithJunction(root, outside))
          }
        },
        { mutation: checked.mutation },
      )
    })
    try {
      await f.spawn({ prompt: "write", maxTurns: 1, extraTools: [f.writer] }).result()
      expect(scheduled).toBe(true)
      expect(f.counts()).toEqual({ executions: 0, approvals: 0 })
      expect(existsSync(path.join(outside, "escaped.txt"))).toBe(false)
    } finally {
      spy.mockRestore()
    }
  },
)

for (const owned of [false, true]) {
  for (const ephemeral of [false, true]) {
    for (const wider of [false, true]) {
      const policy = wider ? "widened" : "omitted"
      const source = owned ? "owned inherit" : "ordinary root"
      const kind = ephemeral ? "private" : "ordinary"
      test.skipIf(!junctionsSupported)(
        `${source}: ${kind} child refuses ${policy} inherited roots after parent junction replacement`,
        async () => {
          const { cwd, root, outside } = fixture()
          const destination = protectedDestination(outside)
          const f = await setup(cwd, root, destination, owned)
          replaceWithJunction(root, outside)
          expect(() =>
            f.spawn({
              prompt: "write",
              ephemeral,
              maxTurns: 1,
              ...(wider ? { writeRoots: [cwd] } : {}),
              extraTools: [f.writer],
            }),
          ).toThrow(/write|identity|ENOENT/i)
          expect(f.counts()).toEqual({ executions: 0, approvals: 0 })
          expect(f.mock.requests).toHaveLength(0)
          expect(existsSync(destination)).toBe(false)
        },
      )

      for (const privateParent of [false, true]) {
        test.skipIf(!junctionsSupported)(
          `${source}: ${kind} grandchild of ${privateParent ? "private" : "ordinary"} child refuses ${policy} roots after junction replacement`,
          async () => {
            const { cwd, root, outside } = fixture()
            const destination = protectedDestination(outside)
            const f = await setup(cwd, root, destination, owned, true)
            const parent = f.spawn({ prompt: "ready", persistent: true, ephemeral: privateParent })
            if (!(parent instanceof Child)) throw new Error("expected tree child")
            await idle(parent)
            expect(parent.agent.writeRoots).toEqual([root])
            replaceWithJunction(root, outside)
            expect(() =>
              parent.agent.tree!.spawn(parent.agent, {
                prompt: "write",
                ephemeral,
                maxTurns: 1,
                ...(wider ? { writeRoots: [cwd] } : {}),
                extraTools: [f.writer],
              }),
            ).toThrow(/write|identity|ENOENT/i)
            expect(f.counts()).toEqual({ executions: 0, approvals: 0 })
            expect(f.mock.requests).toHaveLength(1)
            expect(existsSync(destination)).toBe(false)
            parent.stop()
            await parent.result()
          },
        )
      }
    }
  }
}
