import { expect, test } from "bun:test"
import type { ExtensionAPI, ToolDefinition } from "@amira/api"
import extension from "../src/index.ts"

test("registers the built-in tools (plus powershell on Windows) with the expected concurrency", async () => {
  const tools: ToolDefinition[] = []
  const api: ExtensionAPI = {
    apiVersion: "0.1.0",
    cwd: process.cwd(),
    home: process.cwd(),
    reportError: () => {},
    registerTool: (t) => {
      tools.push(t)
      return () => {}
    },
    registerStatusItem: () => () => {},
    requestRender: () => {},
    settings: {},
    on: () => () => {},
    intercept: () => () => {},
    runCommand: () => Promise.reject(new Error("not used")),
    ui: {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      reviewDiff: async () => undefined,
    },
  }
  await extension(api)
  expect(Object.fromEntries(tools.map((t) => [t.name, t.concurrency]))).toEqual({
    read: "parallel",
    write: "parallel",
    edit: "parallel",
    bash: "parallel",
    ...(process.platform === "win32" ? { powershell: "parallel" } : {}),
    grep: "parallel",
    glob: "parallel",
  })
  for (const t of tools) {
    expect(t.description.length).toBeGreaterThan(50)
    expect(t.parameters.type).toBe("object")
  }
})
