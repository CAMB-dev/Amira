import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CommandContext, OwnedConversation } from "@amira/api"
import { OwnedConversationManager, ToolRegistry } from "@amira/core"
import { closeImageApp, setup, userTexts, waitFor } from "./app-harness.ts"

test("archiving the native focused conversation returns input to main and revokes its incarnation", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "amira-focus-archive-"))
  let conversation!: OwnedConversation
  let context!: CommandContext
  const s = await setup([{ text: "Main reply" }], {
    cwd: home,
    tree: true,
    rows: 24,
    settings: { mode: "fullscreen" },
    commands: [
      {
        name: "owned",
        description: "Focus owned conversation",
        run: (_args, ctx) => {
          context = ctx
          ctx.focusConversation?.(conversation)
        },
      },
    ],
  })
  const manager = new OwnedConversationManager({
    ai: s.ai,
    tools: new ToolRegistry(),
    tree: s.agent.tree!,
    home,
    agent: () => s.agent,
  })
  try {
    const owner = manager.forOwner("project")
    conversation = await owner.openOrCreate(
      { key: "design", name: "Archived design", cwd: home, systemPrompt: "", callableTools: [] },
      { askUser: async () => undefined },
    )
    s.terminal.send("/owned\r")
    await waitFor(() => s.live().includes("Archived design"), "owned focus")
    await owner.archive({ id: conversation.id })
    await waitFor(() => !s.live().includes("main idle"), "archive returns to main")
    expect(context.focusConversation?.(conversation)).toBe(false)
    s.terminal.send("main after archive\r")
    await s.idle()
    expect(userTexts(s.agent)).toEqual(["main after archive"])
    expect((await owner.read({ id: conversation.id }))?.history).toEqual([])
    expect(s.mock.requests).toHaveLength(1)
  } finally {
    await manager.drain()
    await closeImageApp(s)
    rmSync(home, { recursive: true, force: true })
  }
})
