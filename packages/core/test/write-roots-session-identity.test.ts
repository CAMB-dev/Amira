import { afterEach, expect, test } from "bun:test"
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
import { createAi, createMockDialect } from "@amira/ai"
import { textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { intersectWriteRoots } from "../src/permissions/write-roots.ts"
import { SessionStore } from "../src/session-store.ts"

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function supportsJunctions(): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-session-junction-probe-"))
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
  const cwd = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "amira-session-root-identity-")))
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }))
  const root = path.join(cwd, "A")
  const outside = path.join(cwd, "B")
  mkdirSync(root)
  mkdirSync(path.join(outside, ".amira"), { recursive: true })
  const store = SessionStore.create({ cwd, dir: path.join(cwd, "sessions"), writeRoots: [root] })
  store.appendDisplay({ type: "display", text: "persist", level: "info" })
  return { cwd, root, outside, store }
}

function replaceWithJunction(root: string, outside: string) {
  renameSync(root, `${root}-old`)
  symlinkSync(outside, root, process.platform === "win32" ? "junction" : "dir")
}

for (const reopened of [false, true]) {
  for (const junction of [false, true]) {
    test.skipIf(junction && !junctionsSupported)(
      `${reopened ? "opened" : "created"} session fork refuses a write-root replaced by ${junction ? "a junction" : "a directory"}`,
      () => {
        const { root, outside, store } = fixture()
        const loaded = reopened ? SessionStore.open(store.file) : store
        expect(loaded.header.writeRoots).toEqual([root])
        expect(Object.isFrozen(loaded.header.writeRoots)).toBe(true)
        if (junction) replaceWithJunction(root, outside)
        else {
          renameSync(root, `${root}-old`)
          mkdirSync(root)
        }
        expect(() => loaded.fork(null)).toThrow(/write|identity|ENOENT/i)
      },
    )
  }
}

for (const reopened of [false, true]) {
  test.skipIf(!junctionsSupported)(
    `${reopened ? "opened" : "created"} owned session establishes its header roots immediately`,
    () => {
      const { cwd, root, outside } = fixture()
      const store = SessionStore.create({
        cwd,
        dir: path.join(cwd, "owned-sessions"),
        owned: {
          v: 2,
          owner: "fixture-owner",
          spec: {
            key: "fixture",
            name: "fixture",
            cwd,
            model: "mock/test",
            systemPrompt: "test",
            callableTools: [],
            writeRoots: [root],
          },
          runtimeTools: [],
        },
      })
      if (reopened) store.appendDisplay({ type: "display", text: "persist", level: "info" })
      const loaded = reopened ? SessionStore.open(store.file) : store
      const roots = loaded.header.owned!.spec.writeRoots
      expect(roots).toEqual([root])
      expect(Object.isFrozen(roots)).toBe(true)
      replaceWithJunction(root, outside)
      expect(() => intersectWriteRoots(roots, undefined)).toThrow(/write|identity|ENOENT/i)
    },
  )

  test.skipIf(!junctionsSupported)(
    `${reopened ? "opened" : "created"} session header cannot rebase roots before Agent construction`,
    async () => {
      const { cwd, root, outside, store } = fixture()
      const loaded = reopened ? SessionStore.open(store.file) : store
      const destination = path.join(outside, ".amira", "settings.json")
      const mock = createMockDialect([
        { toolCalls: [{ name: "writer", args: { path: destination }, id: "write" }] },
        { text: "done" },
      ])
      const ai = createAi({
        dialects: [mock],
        providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
        retry: { retries: 0 },
      })
      let executions = 0
      let approvals = 0
      replaceWithJunction(root, outside)
      let denied = false
      let agent: Agent | undefined
      try {
        agent = new Agent({
          ai,
          cwd,
          session: loaded,
          model: ai.model("mock/test"),
          sections: [],
          fileRewindSettings: { enabled: false },
          approve: async () => {
            approvals++
            return { approved: true }
          },
        })
      } catch (error) {
        expect(String(error)).toMatch(/write|identity|ENOENT/i)
        denied = true
      }
      if (agent) {
        const running = agent
        cleanups.push(() => running.dispose())
        running.tools.register(
          {
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
          },
          "fixture",
        )
        await running.prompt("write")
      }
      expect({ executions, approvals }).toEqual({ executions: 0, approvals: 0 })
      expect(existsSync(destination)).toBe(false)
      expect(denied).toBe(true)
      expect(mock.requests).toHaveLength(0)
    },
  )
}

test("unchanged session roots survive reopen, fork and Agent construction", async () => {
  const { cwd, root, store } = fixture()
  const loaded = SessionStore.open(store.file)
  const fork = loaded.fork(null)
  const reopened = SessionStore.open(fork.file)
  expect(reopened.header.writeRoots).toEqual([root])
  const mock = createMockDialect()
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
  })
  const agent = new Agent({ ai, cwd, session: reopened, model: ai.model("mock/test"), sections: [] })
  cleanups.push(() => agent.dispose())
  expect(agent.writeRoots).toEqual([root])
  expect(Object.isFrozen(agent.writeRoots)).toBe(true)
  expect(mock.requests).toHaveLength(0)
})
