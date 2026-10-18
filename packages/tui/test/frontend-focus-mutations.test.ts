import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { OwnedConversation } from "@amira/api"
import { Agent, type AgentPort, createLocalAgentPort, EventBus } from "@amira/core"
import { Editor, type EditorPart } from "@amira/tui-kit"
import { ConversationEvents } from "../../core/src/owned-conversations-events.ts"
import { ConversationFocus } from "../src/app/conversation-focus.ts"
import { PromptHistory } from "../src/prompt-history.ts"
import type { TranscriptView } from "../src/view.ts"

for (const destination of ["focused", "main", "replaced"] as const) {
  test(`owned send rejects into its own draft, destination=${destination}`, async () => {
    const ai = createAi({
      dialects: [createMockDialect([])],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    })
    const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: process.cwd() })
    const local = createLocalAgentPort({ agent })
    const pending = Promise.withResolvers<never>()
    const calls: { operation: string; params: unknown; generation?: number }[] = []
    let generation = 1
    const port: AgentPort = {
      get snapshot() {
        return { ...local.snapshot, sessionGeneration: generation }
      },
      subscribe: () => () => {},
      execute: async (operation, params, options) => {
        calls.push({ operation, params, generation: options?.sessionGeneration })
        return pending.promise
      },
      detach: async () => {},
    }
    const editor = new Editor()
    editor.setText("Main draft")
    const notices: string[] = []
    const view = {
      setVisible: () => {},
      openSession: () => {},
      activate: () => {},
      start: () => {},
      stop: () => {},
      requestRender: () => {},
      notice: (_: unknown, text: string) => notices.push(text),
    } as unknown as TranscriptView
    const events = new ConversationEvents(new EventBus())
    const conversation: OwnedConversation = {
      id: "opaque-owned-id",
      key: "owned",
      name: "Owned",
      cwd: agent.cwd,
      data: agent.data,
      events,
      history: () => [],
      usage: () => {
        throw new Error("fixture does not read accounting")
      },
      complete: async () => {
        throw new Error("fixture does not complete")
      },
      status: () => ({ state: "idle", busy: false }),
      send: async () => {
        throw new Error("Must send through the port")
      },
      stop: async () => {
        throw new Error("Must stop through the port")
      },
      release: async () => events.close(),
      runTool: async () => {
        throw new Error("Unused")
      },
      createGroup: () => {
        throw new Error("Unused")
      },
    }
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
      showNote: (text) => notices.push(text),
      syncDialogs: () => {},
      request: () => {},
      resolved: () => {},
    })
    const image = { type: "image" as const, name: "fixture.png", mimeType: "image/png", data: "AQID" }
    const parts: EditorPart[] = ["before", { image }, "after"]
    try {
      expect(focus.focus(conversation)).toBe(true)
      expect(focus.submit("beforeafter", parts, "preview")).toBe(true)
      expect(focus.busy).toBe(true)
      await Bun.sleep(0)
      expect(calls).toEqual([
        {
          operation: "conversation.send",
          generation: 1,
          params: {
            conversationId: "opaque-owned-id",
            incarnation: expect.any(String),
            turnId: expect.any(String),
            message: {
              role: "user",
              content: [{ type: "text", text: "before" }, image, { type: "text", text: "after" }],
              display: { text: "preview" },
            },
          },
        },
      ])
      focus.interrupt()
      await Bun.sleep(0)
      // An in-flight send without authoritative turn identity must not stop a future turn.
      expect(calls[1]).toBeUndefined()
      if (destination === "main") expect(focus.unfocus()).toBe(true)
      else if (destination === "replaced") generation++
      pending.reject(new Error("Disconnected"))
      await Bun.sleep(0)
      if (destination === "main") {
        expect(editor.getText()).toBe("Main draft")
        expect(focus.focus(conversation)).toBe(true)
      }
      if (destination === "replaced") {
        expect(editor.isEmpty).toBe(true)
        expect(notices).toEqual([])
      } else {
        expect(editor.getParts()).toEqual(parts)
        expect(notices).toContain("Disconnected")
      }
      expect(focus.busy).toBe(false)
    } finally {
      focus.dispose()
      events.close()
      await local.detach()
      await agent.dispose("exit")
    }
  })
}
