import { spyOn } from "bun:test"
import type { MockStep } from "@amira/ai"
import type { CommandContext, OwnedConversation } from "@amira/api"
import { Agent, EventBus } from "@amira/core"
import { ConversationEvents } from "../../core/src/owned-conversations-events.ts"
import {
  registerConversationHold,
  registerConversationSend,
  registerConversationTurn,
} from "../../core/src/session-routing.ts"
import * as runner from "../src/app/command-runner.ts"
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
  let frontend!: runner.CommandRunnerOptions
  const create = runner.createCommandRunner
  const capture = spyOn(runner, "createCommandRunner").mockImplementation((options) => {
    frontend = options
    return create(options)
  })
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
  }).finally(() => capture.mockRestore())
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
  const send = async (text: string, options?: Parameters<OwnedConversation["send"]>[1], turnId?: string) => {
    const result = await owned.prompt(
      {
        role: "user",
        content: [...(text ? [{ type: "text" as const, text }] : []), ...(options?.images ?? [])],
        ...(options?.display ? { display: options.display } : {}),
      },
      { turnId },
    )
    if (result.reason === "error") throw new Error(result.error ?? "owned conversation turn failed")
  }
  conversation = {
    id: owned.sessionId,
    key: "design",
    name,
    cwd: owned.cwd,
    data: owned.data,
    history: () => owned.messages,
    usage: () => {
      throw new Error("fixture does not read accounting")
    },
    complete: async () => {
      throw new Error("fixture does not complete")
    },
    status: () => ({ state: owned.busy ? "working" : "idle", busy: owned.busy }),
    events,
    send,
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
  registerConversationTurn(conversation, () => owned.turnId)
  registerConversationHold(conversation, () => owned.holdId)
  registerConversationSend(conversation, (text, options, turnId) =>
    Reflect.apply(conversation.send, conversation, [text, options, turnId]),
  )
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
        openView: frontend.openView,
        quit: frontend.quit,
        focusConversation: frontend.focusConversation,
        unfocusConversation: frontend.unfocusConversation,
      })
    } finally {
      off()
    }
    if (!captured) throw new Error("No active frontend context")
    return captured
  }
  // Most focus tests use context() as a live keyboard/test driver, not a retained command.
  // Keep actual invocation capabilities separately so origin-fencing tests do not bypass them.
  const driver = () =>
    context && {
      ...context,
      openView: frontend.openView,
      openRewind: frontend.openRewind,
      quit: frontend.quit,
      focusConversation: frontend.focusConversation,
      unfocusConversation: frontend.unfocusConversation,
    }
  return {
    ...s,
    conversation,
    owned,
    ownedBus: bus,
    context: driver,
    invocationContext: () => context,
    viewContext,
    stops: () => stops,
  }
}
