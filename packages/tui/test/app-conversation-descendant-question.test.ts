import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ChildSession, OwnedConversation } from "@amira/api"
import { askUserTool } from "../../../extensions/builtin-tools/src/ask-user.ts"
import { OwnedConversationManager } from "../../core/src/owned-conversations.ts"
import { closeImageApp, setup, waitFor } from "./app-harness.ts"

for (const mode of ["inline", "fullscreen"] as const) {
  for (const beforeFocus of [false, true]) {
    test(`${mode}: a real restricted descendant question is answered in its owned conversation, started before focus=${beforeFocus}`, async () => {
      const home = mkdtempSync(join(tmpdir(), "amira-native-descendant-"))
      let owned!: OwnedConversation
      let child: ChildSession | undefined
      const question = {
        question: "Child needs a human choice?",
        options: [
          { label: "Simple", description: "Keep it small" },
          { label: "Detailed", description: "Show details" },
        ],
      }
      const s = await setup(
        [
          { toolCalls: [{ name: "ask_user", args: { questions: [question] } }] },
          { text: "Child received the human choice" },
        ],
        {
          tree: true,
          settings: { mode },
          commands: [
            {
              name: "design",
              description: "Focus then start a restricted child",
              run: (_args, ctx) => {
                expect(ctx.focusConversation?.(owned)).toBe(true)
                if (!beforeFocus)
                  child = owned.createGroup({ name: "Research" }).spawn({ prompt: "Ask the human" })
              },
            },
          ],
        },
      )
      const tree = s.agent.tree
      if (!tree) throw new Error("fixture requires a tree")
      s.agent.tools.register(askUserTool, "test-ask")
      const manager = new OwnedConversationManager({
        ai: s.ai,
        tools: s.agent.tools,
        tree,
        home,
        agent: () => s.agent,
      })
      try {
        owned = await manager.forOwner("project").openOrCreate(
          {
            key: "design",
            name: "Design production",
            cwd: home,
            systemPrompt: "Research only",
            callableTools: ["ask_user"],
          },
          { askUser: (questions, context) => s.host.ui.api("project").ask(questions, context) },
        )
        if (beforeFocus) {
          child = owned.createGroup({ name: "Research" }).spawn({ prompt: "Ask the human" })
          await waitFor(() => s.host.ui.pending.length === 1, "question waiting before subscription")
        }
        s.terminal.send("/design\r")
        await waitFor(() => !!child && s.host.ui.pending.length === 1, "real descendant pending question")
        expect(s.host.ui.pending[0]?.sessionId).toBe(child!.id)
        expect(child!.parentSessionId).toBe(owned.id)
        await s.shows(question.question)
        expect(s.live()).toContain("Design production")
        expect(s.live()).not.toContain("1 pending")
        s.terminal.send("\r")
        const result = await child!.result()
        expect(result.status).toBe("done")
        expect(result.text).toContain("Child received the human choice")
        expect(s.agent.messages).toEqual([])
        expect(s.mock.requests).toHaveLength(2)
        const tool = s.mock.requests[1]?.messages.find((message) => message.role === "toolResult")
        expect(JSON.stringify(tool)).toContain("Simple")
      } finally {
        s.host.ui.cancelAll()
        await manager.drain()
        await closeImageApp(s)
        rmSync(home, { recursive: true, force: true })
      }
    })
  }
}
