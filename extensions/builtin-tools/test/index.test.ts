import { expect, test } from "bun:test"
import "../../../packages/core/src/index.ts"
import { type ExtensionAPI, hostBackgroundJobs, type ToolDefinition } from "@amira/api"
import extension from "../src/index.ts"

test("registers the built-in tools (plus powershell on Windows) with the expected concurrency", async () => {
  const tools: ToolDefinition[] = []
  const renderers: string[] = []
  const api: ExtensionAPI = {
    terminal: { setTitle: () => {}, setProgress: () => {}, bell: () => {} },
    registerWorkspaceProvider: () => () => {},
    registerFileRestoration: () => () => {},
    apiVersion: "0.1.0",
    cwd: process.cwd(),
    home: process.cwd(),
    dataDir: process.cwd(),
    reportError: () => {},
    notify: () => {},
    onExit: () => () => {},
    registerTool: (t) => {
      tools.push(t)
      return () => {}
    },
    registerCommand: () => () => {},
    registerSkill: () => () => {},
    registerTheme: () => () => {},
    registerInputHandler: () => () => {},
    registerStatusItem: () => () => {},
    registerToolRenderer: (name) => {
      renderers.push(name)
      return () => {}
    },
    decorateToolRenderer: () => () => {},
    registerView: () => () => {},
    registerPanel: () => () => {},
    registerMarkdownRenderer: () => () => {},
    registerImageProvider: () => () => {},
    provideService: () => () => {},
    useService: () => undefined,
    requestRender: () => {},
    settings: { layers: () => [] },
    complete: () => Promise.reject(new Error("not used")),
    session: () => undefined,
    backgroundJobs: hostBackgroundJobs(),
    on: () => () => {},
    intercept: () => () => {},
    runCommand: () => Promise.reject(new Error("not used")),
    openPipe: () => {
      throw new Error("not used")
    },
    ui: {
      select: async () => undefined,
      choose: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      reviewDiff: async () => undefined,
      ask: async () => undefined,
      form: async () => undefined,
    },
  }
  await extension(api)
  expect(Object.fromEntries(tools.map((t) => [t.name, t.concurrency]))).toEqual({
    read: "parallel",
    write: "parallel",
    edit: "parallel",
    apply_patch: "serial",
    bash: "parallel",
    ...(process.platform === "win32" ? { powershell: "parallel" } : {}),
    grep: "parallel",
    output_read: "parallel",
    glob: "parallel",
    // Questions for the user wait for each other and for everything else.
    ask_user: undefined,
    job_output: "parallel",
    job_stop: "parallel",
    job_list: "parallel",
  })
  for (const t of tools) {
    expect(t.description.length).toBeGreaterThan(50)
    expect(t.parameters.type).toBe("object")
  }
  // Every built-in tool is presented through the public renderer API (D1, D27).
  for (const t of tools) expect(renderers).toContain(t.name)
})
