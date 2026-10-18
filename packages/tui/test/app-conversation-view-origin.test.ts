import { expect, test } from "bun:test"
import { type CommandContext, type Extension, emptyUsage, type SubagentInfo } from "@amira/api"
import { Agent } from "@amira/core"
import { agentsCommand } from "../../../extensions/agent/src/agents-command.ts"
import { subagentView } from "../../../extensions/agent/src/subagent-view.ts"
import { closeImageApp, exchange, userTexts, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

const F6 = "\x1b[17~"
const agentViews: Extension = (api) => {
  api.registerCommand(agentsCommand())
  api.registerView(subagentView(api))
}

async function agentsFixture(mode: "fullscreen") {
  const child: SubagentInfo = {
    id: "main-child",
    parentSessionId: "main",
    depth: 1,
    role: "explorer",
    title: "Main child",
    task: "MAIN CHILD PRIVATE TASK",
    status: "running",
    usage: emptyUsage(),
  }
  const stopped: string[] = []
  const s = await focusFixture(mode, [{ text: "Owned reply" }], "/work/design", {
    cols: 90,
    rows: 32,
    extensions: [agentViews],
    control: {
      subagents: () => [child],
      subagentMessages: () => [],
      stopSubagent: (id) => {
        stopped.push(id)
        return true
      },
    },
  })
  child.parentSessionId = s.agent.sessionId
  s.host.setSessionControl(s.commands!.control, () => s.commands!.agent)
  return { ...s, stopped }
}

async function close(s: Awaited<ReturnType<typeof focusFixture>>) {
  s.host.ui.cancelAll()
  s.context()?.unfocusConversation?.()
  await s.conversation.release()
  s.terminal.send("\x1b[27u")
  await closeImageApp(s)
}

async function selectMainChildThenFocus(s: Awaited<ReturnType<typeof agentsFixture>>) {
  s.terminal.send("/agents\r")
  await waitFor(
    () => s.live().includes("Sub-agents") && s.live().includes("Main child"),
    "main agents picker",
  )
  expect(s.host.ui.pending).toHaveLength(1)
  // One terminal chunk: the picker resolves synchronously, /design focuses the owned
  // conversation, then the /agents promise resumes and attempts to open the main child.
  s.terminal.send("\r/design\r")
  await waitFor(() => !!s.context(), "design command from the same input chunk")
  await s.bus.flush()
  await Bun.sleep(80)
}

function delayedView(placement: "fullscreen" | "dock") {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = false
  const opened: boolean[] = []
  const immediate: boolean[] = []
  const request = { kind: "origin-bound", placement, ...(placement === "dock" ? { maxHeight: 6 } : {}) }
  const run = async (_args: string, ctx: CommandContext) => {
    started = true
    await gate
    opened.push(ctx.openView!(request))
  }
  const extension: Extension = (api) => {
    api.registerView({
      kind: "origin-bound",
      title: () => "Origin-bound view",
      render: () => [{ kind: "text", text: "ORIGIN VIEW CONTENT" }],
    })
    api.registerCommand({ name: "later", description: "Delayed view", run })
    api.registerCommand({
      name: "now",
      description: "Immediate view",
      run: (_args, ctx) => void immediate.push(ctx.openView!(request)),
    })
    api.registerCommand({
      name: "replace",
      description: "Replace the main root",
      run: async (_args, ctx) => void (await ctx.session.newSession()),
    })
    api.registerSkill({ name: "later", description: "Delayed skill view", run })
    api.registerInputHandler({ name: "later", claims: (text) => text === "delayed-view-input", run })
  }
  return { extension, release, opened, immediate, started: () => started }
}

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: /agents picker continuation cannot show a main child over owned focus or steal input`, async () => {
    const s = await agentsFixture(mode)
    try {
      await selectMainChildThenFocus(s)
      expect(s.live()).toContain("Design · fixture")
      expect(s.live()).not.toContain("task: MAIN CHILD PRIVATE TASK")
      expect(s.live()).not.toContain("x stop")
      s.terminal.send("Owned input after agents picker\r")
      await waitFor(
        () => userTexts(s.owned).includes("Owned input after agents picker"),
        "owned input after picker continuation",
      )
      await s.ownedBus.flush()
      expect(userTexts(s.agent)).toEqual(["Main history"])
      expect(userTexts(s.owned)).toEqual(["Design history", "Owned input after agents picker"])
    } finally {
      await close(s)
    }
  })

  test(`${mode}: a late /agents main child view cannot confirm or stop a child while owned focus is foreground`, async () => {
    const s = await agentsFixture(mode)
    try {
      await selectMainChildThenFocus(s)
      s.terminal.send("x")
      await Bun.sleep(80)
      const confirmations = s.host.ui.pending.filter((request) => request.kind === "confirm")
      // Exercise the real confirmation keys too: a leaked main view must never gain
      // authority to stop its child just because the next keys answer its dialog.
      s.terminal.send("y\r")
      await Bun.sleep(80)
      expect(s.stopped).toEqual([])
      expect(confirmations).toEqual([])
      await waitFor(
        () => userTexts(s.owned).includes("xy"),
        "x and confirmation-looking input routed to owned conversation",
      )
      expect(userTexts(s.agent)).toEqual(["Main history"])
    } finally {
      await close(s)
    }
  })

  for (const placement of ["fullscreen", "dock"] as const) {
    for (const [entry, input] of [
      ["command", "/later\r"],
      ["skill", "$later\r"],
      ["input handler", "delayed-view-input\r"],
    ] as const) {
      test(`${mode}: delayed ${entry} openView(${placement}) rejects a different foreground conversation`, async () => {
        const delayed = delayedView(placement)
        const s = await focusFixture(mode, [{ text: "Owned reply" }], "/work/design", {
          extensions: [delayed.extension],
        })
        try {
          s.terminal.send(input)
          await waitFor(delayed.started, `delayed ${entry} starts in main`)
          s.terminal.send("/design\r")
          await waitFor(() => s.live().includes("Design · fixture"), "owned focus before continuation")
          delayed.release()
          await waitFor(() => delayed.opened.length === 1, "delayed view attempt")
          await s.bus.flush()
          await Bun.sleep(50)
          expect(delayed.opened).toEqual([false])
          expect(s.live()).not.toContain("ORIGIN VIEW CONTENT")
          expect(s.live()).toContain("Design · fixture")
          s.terminal.send("Owned input after delayed view\r")
          await waitFor(
            () => userTexts(s.owned).includes("Owned input after delayed view"),
            "owned input after delayed view",
          )
          await s.ownedBus.flush()
          expect(userTexts(s.agent)).toEqual(["Main history"])
          expect(userTexts(s.owned)).toEqual(["Design history", "Owned input after delayed view"])
        } finally {
          delayed.release()
          await close(s)
        }
      })
    }

    test(`${mode}: delayed openView(${placement}) rejects an actually replaced main root, while fresh views still work`, async () => {
      const delayed = delayedView(placement)
      let replacement: Agent | undefined
      const s = await focusFixture(mode, [{ text: "Replacement reply" }], "/work/design", {
        extensions: [delayed.extension],
        control: {
          newSession: async () => {
            replacement = new Agent({
              ai: s.ai,
              model: s.ai.model("mock/m1"),
              cwd: "/work/replacement",
              systemPrompt: "",
              bus: s.bus,
              tools: s.agent.tools,
            })
            replacement.messages.push(...exchange("Replacement history"))
            s.commands!.switchTo(replacement)
          },
        },
      })
      try {
        s.terminal.send("/later\r")
        await waitFor(delayed.started, "delayed command starts in original root")
        s.terminal.send("/replace\r")
        await waitFor(() => s.live().includes("/work/replacement"), "replacement root is foreground")
        expect(s.commands!.agent).toBe(replacement!)
        expect(replacement!.sessionId).not.toBe(s.agent.sessionId)
        delayed.release()
        await waitFor(() => delayed.opened.length === 1, "stale root view attempt")
        await s.bus.flush()
        await Bun.sleep(50)
        expect(delayed.opened).toEqual([false])
        expect(s.live()).not.toContain("ORIGIN VIEW CONTENT")
        s.terminal.send("Replacement input\r")
        await waitFor(
          () => userTexts(replacement!).includes("Replacement input"),
          "input goes to replacement root",
        )
        await waitFor(() => replacement!.status === "idle", "replacement reply finishes")
        await s.bus.flush()
        expect(userTexts(s.agent)).toEqual(["Main history"])
        expect(userTexts(s.owned)).toEqual(["Design history"])
        s.terminal.send("/now\r")
        await waitFor(() => delayed.immediate.length === 1, "fresh replacement context opens view")
        expect(delayed.immediate).toEqual([true])
        await waitFor(() => s.live().includes("ORIGIN VIEW CONTENT"), "fresh replacement view renders")
      } finally {
        delayed.release()
        replacement?.abort()
        await close(s)
      }
    })

    test(`${mode}: delayed openView(${placement}) still works after returning to its unchanged main scope`, async () => {
      const delayed = delayedView(placement)
      const s = await focusFixture(mode, [], "/work/design", { extensions: [delayed.extension] })
      try {
        s.terminal.send("/later\r")
        await waitFor(delayed.started, "delayed command starts")
        s.terminal.send("/design\r")
        await waitFor(() => s.live().includes("main idle"), "owned conversation is foreground")
        s.terminal.send(F6)
        await waitFor(() => !s.live().includes("main idle"), "return to unchanged main root")
        delayed.release()
        await waitFor(() => delayed.opened.length === 1, "same-scope delayed view attempt")
        expect(delayed.opened).toEqual([true])
        await waitFor(() => s.live().includes("ORIGIN VIEW CONTENT"), "same-scope view renders")
        s.terminal.send("\x1b[27u")
        await waitFor(() => !s.live().includes("ORIGIN VIEW CONTENT"), "normal view closes")
        s.terminal.send("/now\r")
        await waitFor(() => delayed.immediate.length === 1, "normal view command")
        expect(delayed.immediate).toEqual([true])
        await waitFor(() => s.live().includes("ORIGIN VIEW CONTENT"), "normal view still renders")
      } finally {
        delayed.release()
        await close(s)
      }
    })
  }
}

for (const source of ["command", "skill", "input"] as const) {
  for (const effect of ["openRewind", "focusConversation", "unfocusConversation", "quit"] as const) {
    test(`delayed ${source} ${effect} cannot act on replacement foreground focus`, async () => {
      const gate = Promise.withResolvers<void>()
      const done = Promise.withResolvers<void>()
      let started = false
      let ended = false
      let target!: Parameters<NonNullable<CommandContext["focusConversation"]>>[0]
      const extension: Extension = (api) => {
        const run = async (_args: string, ctx: CommandContext) => {
          started = true
          await gate.promise
          if (effect === "focusConversation") expect(ctx.focusConversation!(target)).toBe(false)
          else if (effect === "quit") ctx.quit()
          else expect(ctx[effect]!()).toBe(false)
          done.resolve()
        }
        api.registerCommand({ name: "later-origin", description: "Delayed", run })
        api.registerSkill({ name: "later-origin", description: "Delayed", run })
        api.registerInputHandler({
          name: "later-origin",
          claims: (line) => line === "later-origin-input",
          run,
        })
      }
      const s = await focusFixture("fullscreen", [], "/work/design", { extensions: [extension] })
      target = s.conversation
      void s.exited.then(() => {
        ended = true
      })
      try {
        s.terminal.send(
          `${source === "command" ? "/later-origin" : source === "skill" ? "$later-origin" : "later-origin-input"}\r`,
        )
        await waitFor(() => started, "delayed invocation")
        s.terminal.send("/design\r")
        await waitFor(() => s.live().includes("Design · fixture"), "replacement focus")
        s.terminal.send("Owned draft")
        await waitFor(() => s.live().includes("Owned draft"), "owned draft")
        gate.resolve()
        await done.promise
        await s.bus.flush()
        await Bun.sleep(10)
        expect(ended).toBe(false)
        expect(s.live()).toContain("Design · fixture")
        expect(s.live()).toContain("Owned draft")
        expect(s.all()).not.toContain("Rewind is waiting on main")
      } finally {
        gate.resolve()
        await close(s)
      }
    })
  }
}

test("live fixture controls do not grant a retained invocation fresh foreground authority", async () => {
  const s = await focusFixture("fullscreen", [])
  try {
    s.terminal.send("/design\r")
    await waitFor(() => s.live().includes("Design · fixture"), "owned focus")
    const retained = s.invocationContext()
    s.terminal.send(F6)
    await waitFor(() => !s.live().includes("main idle"), "main focus")
    expect(retained.focusConversation?.(s.conversation)).toBe(false)
    expect(s.context().focusConversation?.(s.conversation)).toBe(true)
  } finally {
    await close(s)
  }
})
