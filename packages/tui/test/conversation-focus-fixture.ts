import type { MockStep } from "@amira/ai"
import type { CommandContext, OwnedConversation } from "@amira/api"
import { Agent, EventBus } from "@amira/core"
import { ConversationEvents } from "../../core/src/owned-conversations-events.ts"
import { exchange, inputImage, type SetupOptions, setup } from "./app-harness.ts"

export async function focusFixture(
  mode: "fullscreen",
  steps: MockStep[] = [{ text: "Main reply" }],
  ownedCwd = "/work/design",
  options: SetupOptions = {},
  name = "Design · fixture",
) {
  let conversation!: OwnedConversation
  let context!: CommandContext
  const s = await setup(steps, {
    rows: 24,
    acceptsImages: true,
    clipboard: async () => ({ type: "image", image: inputImage() }),
    history: exchange("Main history"),
    files: ["main-only.ts"],
    settings: { mode },
    commands: [
      {
        name: "design",
        description: "Focus design",
        run: (_args, ctx) => {
          context = ctx
          ctx.focusConversation?.(conversation)
        },
      },
      { name: "clear", description: "Main only", run: (_args, ctx) => ctx.print("CLEARED MAIN") },
    ],
    ...options,
  })
  const bus = new EventBus()
  const events = new ConversationEvents(bus)
  const owned = new Agent({
    ai: s.ai,
    model: s.ai.model("mock/m1"),
    cwd: ownedCwd,
    systemPrompt: "",
    bus,
  })
  owned.messages.push(...exchange("Design history"))
  let stops = 0
  conversation = {
    id: owned.sessionId,
    key: "design",
    name,
    cwd: owned.cwd,
    data: owned.data,
    history: () => owned.messages,
    status: () => ({ state: owned.status === "idle" ? "idle" : "working", busy: owned.status !== "idle" }),
    events,
    send: async (text, options) => {
      await owned.prompt({
        role: "user",
        content: [...(text ? [{ type: "text" as const, text }] : []), ...(options?.images ?? [])],
        ...(options?.display ? { display: options.display } : {}),
      })
    },
    runTool: async () => {
      throw new Error("fixture does not invoke tools")
    },
    stop: async () => {
      stops++
      owned.abort()
    },
    release: async () => {
      owned.abort()
      events.close()
    },
    createGroup: () => {
      throw new Error("not used")
    },
  }
  const viewContext = async () => {
    let captured: CommandContext | undefined
    const off = s.host.commands.register(
      {
        name: "capture-view-context",
        description: "Capture the active frontend scope",
        run: (_args, ctx) => {
          captured = ctx
        },
      },
      "test:context",
    )
    try {
      await s.commands!.run("/capture-view-context", {
        frontend: "tui",
        openView: context.openView,
        quit: context.quit,
        focusConversation: context.focusConversation,
        unfocusConversation: context.unfocusConversation,
      })
    } finally {
      off()
    }
    if (!captured) throw new Error("No active frontend context")
    return captured
  }
  return { ...s, conversation, owned, ownedBus: bus, context: () => context, viewContext, stops: () => stops }
}
