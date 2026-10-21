import { afterEach, expect, spyOn, test } from "bun:test"
import { SPAWN_TEST_TIMEOUT_MS } from "../../../scripts/spawn-test.ts"
import "../../../packages/core/src/index.ts"
import * as apiHost from "@amira/api"
import { type ExtensionAPI, hostBackgroundJobs, type ToolDefinition } from "@amira/api"
import extension from "../src/index.ts"
import * as shells from "../src/shell.ts"

const restore: (() => void)[] = []
afterEach(async () => {
  // Registration schedules warmup for a later turn; keep these mocks until it has fired.
  await Bun.sleep(0)
  for (const undo of restore.splice(0).reverse()) undo()
}, SPAWN_TEST_TIMEOUT_MS)

test("the built-in tools public exports include monitor", async () => {
  expect(Object.keys(await import("../src/index.ts")).sort()).toMatchInlineSnapshot(`
    [
      "applyPatchTool",
      "askUserPresenter",
      "askUserTool",
      "bashTool",
      "builtinPresenters",
      "builtinTools",
      "configureJobs",
      "default",
      "editTool",
      "globTool",
      "grepTool",
      "jobListTool",
      "jobOutputTool",
      "jobStopTool",
      "jobView",
      "jobsCommand",
      "jobsConfig",
      "jobsPanel",
      "monitorTool",
      "outputReadTool",
      "powershellTool",
      "readTool",
      "registerJobs",
      "toolSearchExtension",
      "toolSearchTool",
      "writeTool",
    ]
  `)
})

test(
  "registers the built-in tools (plus powershell on Windows) with the expected concurrency",
  async () => {
    // Registration, not process warmup, is under test. Do not leave production standbys running.
    const shellWarmup = spyOn(shells, "warmUpShell").mockImplementation(() => {})
    const commandWarmup = spyOn(apiHost, "hostWarmUpCommands").mockImplementation(() => {})
    restore.push(
      () => shellWarmup.mockRestore(),
      () => commandWarmup.mockRestore(),
    )
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
      onUnload: () => () => {},
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
      settings: {
        layers: () => [],
        declare: () => {
          throw new Error("not used")
        },
      },
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
        setInputSuggestion: () => {},
        onInputSuggestionAccepted: () => () => {},
        select: async () => undefined,
        choose: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        reviewDiff: async () => undefined,
        ask: async () => undefined,
        form: async () => undefined,
        extensionSettings: async () => undefined,
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
      monitor: "parallel",
    })
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(50)
      expect(t.parameters.type).toBe("object")
    }
    // Every built-in tool is presented through the public renderer API (D1, D27).
    for (const t of tools) expect(renderers).toContain(t.name)
  },
  SPAWN_TEST_TIMEOUT_MS,
)
