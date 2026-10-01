import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import builtinTools from "../../../extensions/builtin-tools/src/index.ts"
import commandsExtension from "../../../extensions/commands/src/index.ts"
import { createCommandHost } from "../src/control.ts"
import { createSession } from "../src/session.ts"

test("session model choices control tool availability, descriptions and /tools", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "amira-editing-tools-"))
  const savedHome = process.env.AMIRA_HOME
  process.env.AMIRA_HOME = dir
  try {
    const mock = createMockDialect([{ text: "done" }])
    const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
    const session = await createSession({
      ai,
      cwd: dir,
      model: "mock/patch",
      extensions: [],
      noBuiltins: false,
      builtins: async () => [
        { source: "builtin:tools", extension: builtinTools },
        { source: "builtin:commands", extension: commandsExtension },
      ],
      settings: { providers: { mock: { models: [{ id: "patch", tools: { edit: "apply_patch" } }] } } },
    })
    const { agent } = session
    const host = createCommandHost({ session, cwd: dir, home: dir })
    const enabled = (name: string) => host.control.tools().find((t) => t.name === name)?.enabled
    const run = (command: string) => host.run(command, { frontend: "print" })
    expect(enabled("edit")).toBe(false)
    expect(enabled("apply_patch")).toBe(true)
    const editEnable = await run("/tools enable edit")
    expect(editEnable.ok).toBe(false)
    expect(editEnable.error).toContain("models[].tools.edit")
    expect(editEnable.output.join("\n")).not.toContain("Enabled edit")
    expect((await run("/tools disable apply_patch")).ok).toBe(true)
    expect(enabled("apply_patch")).toBe(false)
    expect((await run("/tools enable apply_patch")).ok).toBe(true)
    expect(enabled("apply_patch")).toBe(true)
    const preview = await agent.preview()
    expect(preview.tools.map((t) => t.name)).toContain("apply_patch")
    expect(preview.tools.map((t) => t.name)).not.toContain("edit")
    expect(preview.tools.map((t) => t.name)).toContain("write")
    expect(preview.systemPrompt).not.toMatch(/\bedit tool\b|`edit`/)
    for (const tool of preview.tools)
      expect(tool.description).not.toMatch(/\bedit tool\b|`edit`|write, edit,/)
    expect((await agent.prompt("hello")).reason).toBe("done")
    expect(mock.requests[0]!.tools.map((t) => t.name)).not.toContain("edit")
    host.control.setModel("mock/default")
    const defaults = (await agent.preview()).tools.map((t) => t.name)
    expect(defaults).toContain("edit")
    expect(defaults).not.toContain("apply_patch")
    expect(enabled("apply_patch")).toBe(false)
    expect(enabled("edit")).toBe(true)
    expect((await run("/tools")).output.join("\n")).toMatch(/off\s+apply_patch/)
    const patchEnable = await run("/tools enable apply_patch")
    expect(patchEnable.ok).toBe(false)
    expect(patchEnable.error).toContain("providers.mock.tools.edit")
    expect(patchEnable.output.join("\n")).not.toContain("Enabled apply_patch")
    host.control.setModel("mock/patch")
    expect(enabled("apply_patch")).toBe(true)
    expect(enabled("edit")).toBe(false)
  } finally {
    if (savedHome === undefined) delete process.env.AMIRA_HOME
    else process.env.AMIRA_HOME = savedHome
    await rm(dir, { recursive: true, force: true })
  }
})
