import { afterEach, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { type ToolDefinition, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { Permissions } from "../src/permissions/policy.ts"
import { WriteRootPolicy } from "../src/permissions/write-roots.ts"
import { SessionStore } from "../src/session-store.ts"

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture(rewind: boolean, execute: ToolDefinition["execute"]) {
  const cwd = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "amira-write-mutations-")))
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }))
  const root = path.join(cwd, "allowed")
  const home = path.join(cwd, "home")
  mkdirSync(root)
  mkdirSync(home)
  const nested = path.join(root, "nested")
  mkdirSync(nested)
  const a = path.join(nested, "a")
  const b = path.join(nested, "b")
  writeFileSync(a, "original a")
  writeFileSync(b, "original b")
  const mock = createMockDialect([
    { toolCalls: [{ name: "writer", args: { a, b, root }, id: "write" }] },
    { text: "done" },
  ])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
    retry: { retries: 0 },
  })
  const session = rewind ? SessionStore.create({ cwd, dir: path.join(cwd, "sessions") }) : undefined
  const agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd,
    sections: [],
    session,
    writeRoots: [root],
    fileRewindSettings: { enabled: rewind },
    permissions: new Permissions({
      mode: "auto",
      protect: { homedir: home, amiraHome: path.join(home, ".amira"), env: {} },
    }),
  })
  cleanups.push(() => agent.dispose())
  agent.tools.register(
    {
      name: "writer",
      description: "test sequential mutations",
      parameters: { type: "object" },
      traits: { writesFiles: "paths", usesMutationHook: true },
      getWrittenPaths: () => [a, b],
      execute,
    },
    "test",
  )
  return { agent, a, b, root, session }
}

for (const rewind of [false, true]) {
  for (const operation of ["delete", "replace"] as const) {
    test(`sequential ${operation} then write preserves valid targets with rewind ${rewind}`, async () => {
      const { agent, a, b, session } = fixture(rewind, async (args, ctx) => {
        const a = String(args.a)
        const b = String(args.b)
        await ctx.mutateFiles!(
          [{ path: a, after: operation === "delete" ? null : Buffer.from("replacement a") }],
          async () => {
            // Retain the original inode to make replacement deterministic on all platforms.
            renameSync(a, `${a}-old`)
            if (operation === "replace") writeFileSync(a, "replacement a")
          },
        )
        await ctx.mutateFiles!([{ path: b, after: Buffer.from("updated b") }], async () => {
          writeFileSync(b, "updated b")
        })
        // The changed destination remains usable too, including recreation after deletion.
        await ctx.mutateFiles!([{ path: a, after: Buffer.from("updated a") }], async () => {
          writeFileSync(a, "updated a")
        })
        return textResult("done")
      })
      await agent.prompt("go")
      const result = agent.messages.find((message) => message.role === "toolResult")
      expect(result?.content).toEqual(textResult("done").content)
      expect(result?.isError).toBe(false)
      expect(readFileSync(a, "utf8")).toBe("updated a")
      expect(readFileSync(b, "utf8")).toBe("updated b")
      if (session) expect(session.branch().filter((entry) => entry.type === "file_mutation")).toHaveLength(3)
    })
  }

  for (const stale of ["untouched-target", "root", "ancestor", "changed-target"] as const) {
    test(`sequential mutation does not reset stale ${stale} with rewind ${rewind}`, async () => {
      let secondWrite = false
      const { agent, root } = fixture(rewind, async (args, ctx) => {
        const a = String(args.a)
        const b = String(args.b)
        const root = String(args.root)
        await ctx.mutateFiles!(
          [{ path: a, after: stale === "changed-target" ? Buffer.from("pinned a") : null }],
          async () => {
            renameSync(a, `${a}-old`)
            if (stale === "changed-target") writeFileSync(a, "pinned a")
            if (stale === "untouched-target") {
              renameSync(b, `${b}-old`)
              writeFileSync(b, "unapproved b")
            }
            if (stale === "root") {
              renameSync(root, `${root}-old`)
              mkdirSync(root)
            }
            if (stale === "ancestor") {
              const parent = path.dirname(a)
              renameSync(parent, `${parent}-old`)
              mkdirSync(parent)
            }
          },
        )
        if (stale === "changed-target") {
          // A refreshed target must be pinned, not permanently exempted.
          renameSync(a, `${a}-unapproved`)
          writeFileSync(a, "unapproved a")
        }
        await ctx.mutateFiles!([{ path: b, after: Buffer.from("bad") }], async () => {
          secondWrite = true
          writeFileSync(b, "bad")
        })
        return textResult("must not finish")
      })
      await agent.prompt("go")
      expect(secondWrite).toBe(false)
      expect(agent.messages.find((message) => message.role === "toolResult")?.isError).toBe(true)
      if (stale === "root") expect(existsSync(path.join(root, "nested", "b"))).toBe(false)
    })
  }

  test(`failed mutation does not advance target pins with rewind ${rewind}`, async () => {
    let failed = false
    let secondWrite = false
    const { agent } = fixture(rewind, async (args, ctx) => {
      const a = String(args.a)
      const b = String(args.b)
      try {
        await ctx.mutateFiles!([{ path: a, after: Buffer.from("replacement a") }], async () => {
          renameSync(a, `${a}-old`)
          writeFileSync(a, "replacement a")
          throw new Error("writer failed")
        })
      } catch (error) {
        failed = error instanceof Error && error.message === "writer failed"
      }
      await ctx.mutateFiles!([{ path: b, after: Buffer.from("bad") }], async () => {
        secondWrite = true
        writeFileSync(b, "bad")
      })
      return textResult("must not finish")
    })
    await agent.prompt("go")
    expect(failed).toBe(true)
    expect(secondWrite).toBe(false)
    expect(agent.messages.find((message) => message.role === "toolResult")?.isError).toBe(true)
  })
}

test("directory identity checks preserve inode bits beyond Number precision", () => {
  const cwd = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "amira-write-precise-identity-")))
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }))
  const root = path.join(cwd, "allowed")
  const directory = path.join(root, "nested")
  mkdirSync(directory, { recursive: true })
  const before = 9_007_199_254_740_992n
  const after = before + 1n
  expect(Number(before)).toBe(Number(after))
  let replaced = false
  const original = fs.lstatSync
  const spy = spyOn(fs, "lstatSync").mockImplementation(
    new Proxy(original, {
      apply(target, receiver, args) {
        const entry = Reflect.apply(target, receiver, args)
        if (String(args[0]) === directory) {
          const ino = replaced ? after : before
          Object.defineProperty(entry, "ino", { value: typeof entry.ino === "bigint" ? ino : Number(ino) })
        }
        return entry
      },
    }),
  )
  try {
    const check = new WriteRootPolicy([root]).check(cwd, [directory])
    const commit = check.mutation([directory])
    replaced = true
    expect(commit).toThrow("write path identity changed")
    expect(check).toThrow("write path identity changed")
  } finally {
    spy.mockRestore()
  }
})

test("declaring a directory mutation cannot advance its ancestor identity", () => {
  const cwd = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "amira-write-directory-")))
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }))
  const root = path.join(cwd, "allowed")
  const directory = path.join(root, "nested")
  mkdirSync(directory, { recursive: true })
  const check = new WriteRootPolicy([root]).check(cwd, [directory])
  const commit = check.mutation([directory])
  renameSync(directory, `${directory}-old`)
  mkdirSync(directory)
  expect(commit).toThrow("write path identity changed")
  expect(check).toThrow("write path identity changed")
})
