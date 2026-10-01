import { afterAll, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { defineTool, textResult } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { FileRewind } from "../src/file-rewind.ts"
import { SessionStore } from "../src/session-store.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const dirs: string[] = []
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

test("a third-party path writer is captured and restored by file rewind", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "amira-tool-traits-"))
  dirs.push(cwd)
  const session = SessionStore.create({ cwd, dir: path.join(cwd, "sessions") })
  const rewind = new FileRewind(session)
  const mock = createMockDialect([
    {
      toolCalls: [{ name: "third_party_write", args: { path: "created.txt", content: "new" }, id: "call-1" }],
    },
    { text: "done" },
  ])
  const ai = createAi({
    dialects: [mock],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    retry: { retries: 0 },
  })
  const tools = new ToolRegistry()
  tools.register(
    defineTool<{ path: string; content: string }>({
      name: "third_party_write",
      description: "writes one file",
      parameters: { type: "object" },
      traits: { writesFiles: "paths" },
      getWrittenPaths: ({ path: p }) => [p],
      execute: async ({ path: p, content }, ctx) => {
        await writeFile(path.resolve(ctx.cwd, p), content)
        return textResult("written")
      },
    }),
    "test",
  )
  const agent = new Agent({
    ai,
    model: ai.model("mock/test"),
    cwd,
    session,
    fileRewind: rewind,
    tools,
    systemPrompt: "sys",
  })

  await agent.prompt("create the file")
  expect(readFileSync(path.join(cwd, "created.txt"), "utf8")).toBe("new")
  const end = session.entries.find((entry) => entry.type === "file_mutation_end")
  expect(end?.type === "file_mutation_end" && end.files).toMatchObject([
    { path: path.join(cwd, "created.txt"), before: null },
  ])

  const message = session.entries.find((entry) => entry.type === "message" && entry.message.role === "user")
  expect(message).toBeDefined()
  rewind.restore(message!.id, null)
  expect(existsSync(path.join(cwd, "created.txt"))).toBe(false)
})
