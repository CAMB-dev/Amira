import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { Agent, AgentTree, createLocalAgentPort, OwnedConversationManager, ToolRegistry } from "@amira/core"
import { Editor } from "@amira/tui-kit"
import { ConversationFocus } from "../src/app/conversation-focus.ts"
import { PromptHistory } from "../src/prompt-history.ts"
import type { TranscriptView } from "../src/view.ts"

for (const delivery of ["released", "reopened"] as const) {
  test(`a focused send cannot target a ${delivery} conversation incarnation`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amira-incarnation-"))
    const mock = createMockDialect([{ text: "" }])
    const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
    const tools = new ToolRegistry()
    const tree = new AgentTree({ ai, sections: () => [] })
    const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: dir, tools, tree, systemPrompt: "" })
    const manager = new OwnedConversationManager({
      ai,
      tools,
      tree,
      home: dir,
      agent: () => agent,
      canExecute: () => true,
    })
    const owner = manager.forOwner("test")
    const spec = {
      key: "same",
      name: "Same durable conversation",
      cwd: dir,
      systemPrompt: "",
      callableTools: [],
    }
    const runtime = { askUser: async () => undefined }
    const old = await owner.openOrCreate(spec, runtime)
    const port = createLocalAgentPort({ agent })
    const execute = port.execute.bind(port)
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const finished = Promise.withResolvers<void>()
    let failed: unknown
    port.execute = async (operation, params, options) => {
      if (operation !== "conversation.send") return execute(operation, params, options)
      entered.resolve()
      await gate.promise
      try {
        return await execute(operation, params, options)
      } catch (error) {
        failed = error
        throw error
      } finally {
        finished.resolve()
      }
    }
    const editor = new Editor()
    const view = new Proxy({}, { get: () => () => {} }) as TranscriptView
    const focus = new ConversationFocus({
      port,
      editor,
      mainView: view,
      mainHistory: new PromptHistory(),
      mainId: () => agent.sessionId,
      mainContainsSession: () => false,
      mainWorking: () => false,
      interruptMain: () => {},
      canFocus: () => true,
      createView: () => view,
      activate: () => {},
      detachOverlays: () => {},
      prepareOutgoing: () => {},
      resetComposer: () => {},
      showNote: () => {},
      syncDialogs: () => {},
      request: () => {},
      resolved: () => {},
    })
    let replacement: typeof old | undefined
    try {
      expect(focus.focus(old)).toBe(true)
      expect(focus.submit("old pending message", ["old pending message"])).toBe(true)
      await entered.promise
      focus.unfocus()
      await old.release()
      if (delivery === "reopened") {
        replacement = await owner.openOrCreate(spec, runtime)
        expect(replacement.id).toBe(old.id)
        expect(replacement).not.toBe(old)
        expect(focus.focus(replacement)).toBe(true)
      }
      editor.setText("replacement draft")
      gate.resolve()
      await finished.promise
      await Bun.sleep(0)
      expect(mock.requests).toHaveLength(0)
      expect(replacement?.history() ?? []).toEqual([])
      expect(editor.getText()).toBe("replacement draft")
      expect(failed).toMatchObject({ code: "stale_operation" })
    } finally {
      gate.resolve()
      focus.dispose()
      await replacement?.release()
      await manager.drain()
      await port.detach()
      await agent.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
