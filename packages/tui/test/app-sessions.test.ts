import { expect, spyOn, test } from "bun:test"
import { userMessage } from "@amira/ai"
import { defineTool, textResult } from "@amira/api"
import { Agent, AgentBusyError } from "@amira/core"
import commandsExtension from "../../../extensions/commands/src/index.ts"
import {
  ALT_ENTER,
  closeImageApp,
  lastUserText,
  paste,
  QUEUE_HINT,
  setup,
  userTexts,
  waitFor,
} from "./app-harness.ts"

for (const held of ["queued", "Esc flush", "microtask", "nine pastes"] as const) {
  test(`session switching restores ${held} messages before the draft and never sends them automatically`, async () => {
    const release = Promise.withResolvers<void>()
    const s = await setup(
      [{ text: "0123456789ABCDEFGHIJKLMNOPQRSTUV", hold: { chunks: 1, until: release.promise } }],
      { rows: 60, commands: [{ name: "quit", description: "Quit", run: (_args, ctx) => ctx.quit() }] },
    )
    const next = new Agent({ ai: s.ai, model: s.ai.model("mock/m1"), cwd: "/work/proj", bus: s.bus })
    const folded = "queued paste ".repeat(100)
    const extras =
      held === "nine pastes" ? Array.from({ length: 8 }, (_, i) => `paste ${i} `.repeat(200)) : []
    let off = () => {}
    try {
      s.terminal.send("go\r")
      await s.shows("01234567")
      s.terminal.send(`${paste(folded)}${ALT_ENTER}`)
      await waitFor(() => s.live().includes("queued ›"), "queued paste")
      for (const text of extras) s.terminal.send(`${paste(text)}${ALT_ENTER}`)
      s.terminal.send(`second${ALT_ENTER}`)
      await s.shows(extras.length ? "+7 more waiting" : "queued › second")
      if (held === "Esc flush") {
        s.terminal.send("third\r")
        await s.shows("steering › third")
      }
      s.terminal.send("draft")
      await waitFor(() => s.live().includes("draft"), "draft")
      if (held === "Esc flush" || held === "microtask") {
        off = s.bus.subscribe((event) => {
          if (event.type === "turn.end" && event.sessionId === s.agent.sessionId) s.commands!.switchTo(next)
        })
        if (held === "Esc flush") s.terminal.send("\x1b[27u")
        release.resolve()
        await waitFor(() => s.commands!.agent === next, "switch during flush")
      } else s.commands!.switchTo(next)
      s.agent.abort()
      release.resolve()
      await s.idle()
      await Bun.sleep(550)
      expect(next.messages).toEqual([])
      expect(s.live()).not.toContain("queued ›")
      expect(s.live()).not.toContain("steering ›")
      if (!extras.length) expect(s.live()).toContain("[pasted 1300 chars #1]")
      s.mock.push({ text: "new session reply" })
      await next.prompt("new session question")
      await s.bus.flush()
      expect(userTexts(next)).toEqual(["new session question"])
      s.mock.push({ text: "restored input sent" })
      s.terminal.send("\r")
      await s.shows("restored input sent")
      expect(next.messages[2]).toMatchObject({
        display: { text: expect.stringContaining("[pasted 1300 chars #1]") },
      })
      expect(userTexts(next)).toEqual([
        "new session question",
        [folded, ...extras, "second", ...(held === "Esc flush" ? ["third"] : []), "draft"].join("\n\n"),
      ])
    } finally {
      off()
      release.resolve()
      s.agent.abort()
      next.abort()
      await next.prompt("cleanup")
      await s.bus.flush()
      s.terminal.send("\x03/quit\r")
      expect(await s.exited).toBe(0)
    }
  })
}

for (const error of [new AgentBusyError("busy"), new Error("old session failure")]) {
  test(`a late ${error.name} rejection after switching restores the input without a notice`, async () => {
    const s = await setup([], {
      commands: [{ name: "quit", description: "Quit", run: (_args, ctx) => ctx.quit() }],
    })
    const next = new Agent({ ai: s.ai, model: s.ai.model("mock/m1"), cwd: "/work/proj", bus: s.bus })
    const prompt = spyOn(s.agent, "prompt").mockRejectedValue(error)
    try {
      s.terminal.send("pending input\r")
      s.commands!.switchTo(next)
      await Bun.sleep(30)
      expect(s.live()).toContain("│ › pending input")
      expect(s.live()).not.toContain("queued ›")
      expect(s.all()).not.toContain(error.message)
      s.mock.push({ text: "new session reply" })
      await next.prompt("new session question")
      await s.bus.flush()
      expect(userTexts(next)).toEqual(["new session question"])
    } finally {
      prompt.mockRestore()
      next.abort()
      await next.prompt("cleanup")
      await s.bus.flush()
      s.terminal.send("\x03/quit\r")
      expect(await s.exited).toBe(0)
    }
  })
}

for (const mode of ["fullscreen", "inline"] as const) {
  test(`${mode}: /resume names the resumed session once in its boundary`, async () => {
    let next!: Agent
    const s = await setup([], {
      cols: 100,
      settings: { mode },
      extensions: [commandsExtension],
      control: {
        info: () => ({
          id: "current",
          cwd: "/work/proj",
          busy: false,
          model: { provider: "mock", model: "m1" },
          contextWindow: 128_000,
          shell: "auto",
        }),
        sessions: () => [
          {
            id: next.sessionId,
            updatedAt: Date.now(),
            title: "Repair the build",
            firstUserText: "Restored question",
            messageCount: 1,
          },
        ],
        resume: async (id) => {
          expect(id).toBe(next.sessionId)
          await Bun.sleep(40) // Let the answered picker render while the session opens.
          s.commands!.switchTo(next)
        },
      },
    })
    next = new Agent({ ai: s.ai, model: s.ai.model("mock/m1"), cwd: "/work/proj", bus: s.bus })
    next.messages.push(userMessage("Restored question"))
    try {
      s.terminal.send("/resume\r")
      await waitFor(() => s.live().includes("Resume which session?"), "resume picker")
      s.terminal.send("\r")
      await waitFor(() => s.commands!.agent === next, "session switched")
      await s.shows("Restored question")
      await s.idle()
      expect(s.commands!.agent).toBe(next)
      expect(s.all()).toContain(`── resumed ${next.sessionId}`)
      expect(
        s
          .all()
          .split("\n")
          .filter((line) => line.includes(next.sessionId)),
      ).toEqual([expect.stringContaining(`── resumed ${next.sessionId}`)])
      expect(s.all()).not.toContain("Resumed session")
    } finally {
      await closeImageApp(s)
    }
  })

  for (const cols of [120, 60]) {
    test(`rewind picker offers fork from here at ${cols} columns in ${mode}`, async () => {
      const forks: number[] = []
      const rewinds: number[] = []
      const history = [
        userMessage("first question"),
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "answer" }],
          model: { provider: "mock", model: "m1" },
        },
        userMessage("second question"),
      ]
      const { terminal, live, shows, exited } = await setup([], {
        cols,
        settings: { mode },
        history,
        commands: [],
        control: {
          rewind: async (i) => {
            rewinds.push(i)
          },
          fork: async (i) => {
            forks.push(i!)
          },
        },
      })
      terminal.send("\x1b[27u\x1b[27u")
      await waitFor(() => live().includes("Rewind the conversation"), "rewind picker")
      expect(live()).toContain("fork from here")
      expect(live()).toContain("second question")
      terminal.send("f")
      await shows("Forked the conversation")
      expect(forks).toEqual([2])
      expect(rewinds).toEqual([])
      expect(history).toHaveLength(3)
      terminal.send("\x03\x03")
      await exited
    })

    test(`resume content picker deletes with confirmation at ${cols} columns in ${mode}`, async () => {
      const deleted: string[] = []
      const { terminal, live, exited } = await setup([], {
        cols,
        settings: { mode },
        commands: [
          {
            name: "sessions",
            description: "Sessions",
            async run(_args, ctx) {
              const choice = await ctx.ui.choose(
                "Resume which session?",
                ["s_a Unrelated", "s_b Database repair"],
                {
                  sections: [{ at: 0, choose: "resume", keys: [{ key: "d", label: "delete" }] }],
                  searchTexts: ["other content", "Assistant text: 数据库连接"],
                },
              )
              if (choice?.key === "d" && (await ctx.ui.confirm("Delete this session?", choice.option)))
                deleted.push(choice.option)
            },
          },
        ],
      })
      terminal.send("/sessions\r")
      await waitFor(() => live().includes("Resume which session?"), "resume picker")
      terminal.send("数据库")
      await waitFor(() => live().includes("Assistant text:"), "matching snippet")
      expect(live()).not.toContain("s_a Unrelated")
      expect(live()).toContain("s_b Database repair")
      terminal.send("\x1b[100;5u")
      await waitFor(() => live().includes("Delete this session?"), "delete confirmation")
      expect(deleted).toEqual([])
      terminal.send("n")
      await waitFor(() => !live().includes("Delete this session?"), "confirmation cancelled")
      expect(deleted).toEqual([])
      terminal.send("\x03\x03")
      await exited
    })

    test(`resume picker reports an active-session deletion refusal at ${cols} columns in ${mode}`, async () => {
      const refusal =
        "cannot delete session s_b: it is open in another Amira process (pid 42); close that process first"
      const { terminal, live, all, host, exited } = await setup([], {
        cols,
        settings: { mode },
        commands: [],
        control: {
          info: () => ({
            id: "current",
            cwd: "/work/proj",
            busy: false,
            model: { provider: "mock", model: "m1" },
            contextWindow: 128_000,
            shell: "auto",
          }),
          sessions: () => [
            {
              id: "s_b",
              updatedAt: Date.now(),
              title: "Database repair",
              firstUserText: "hello",
              searchText: "hello",
              messageCount: 2,
            },
          ],
          deleteSession: async () => {
            throw new Error(refusal)
          },
        },
      })
      await host.load(commandsExtension, `test-resume-active-${mode}-${cols}`)
      terminal.send("/resume\r")
      await waitFor(() => live().includes("Resume which session?"), "active-session resume picker")
      terminal.send("\x1b[100;5u")
      await waitFor(() => live().includes("Delete this session?"), "active-session delete confirmation")
      terminal.send("\x1b[B\r")
      const normalized = () => all().replace(/\s+/g, " ")
      await waitFor(() => normalized().includes("open in another Amira process"), "active-session refusal")
      expect(normalized()).toContain(refusal)
      terminal.send("\x03\x03")
      await exited
    })
  }
}

test("Esc twice opens the rewind picker; the message picked is cut off and back in the input", async () => {
  const rewound: number[] = []
  const { terminal, live, all, agent, shows, idle, exited } = await setup(
    [{ text: "first answer" }, { text: "second answer" }],
    {
      commands: [],
      control: {
        rewind: async (index: number) => {
          rewound.push(index)
          agent.messages.splice(index)
        },
      },
    },
  )
  terminal.send("first question\r")
  await shows("first answer")
  await idle()
  terminal.send("second question\r")
  await shows("second answer")
  await idle()
  terminal.send("\x1b[27u\x1b[27u")
  await waitFor(() => live().includes("? Rewind the conversation"), "the picker")
  // Newest first.
  expect(live()).toMatch(/❯ 1 second question\n.*2 first question/)
  terminal.send("\r")
  await shows("Files were not restored")
  expect(rewound).toEqual([2])
  expect(live()).toContain("› second question")
  expect(all()).toContain("Rewound the conversation")
  terminal.send("\x03")
  terminal.send("\x03")
  await exited
})

test("a command opens the same rewind picker through openRewind", async () => {
  const rewound: number[] = []
  const { terminal, live, agent, shows, idle, exited } = await setup([{ text: "an answer" }], {
    commands: [
      {
        name: "rewind",
        description: "Rewind",
        run: (_args, ctx) => {
          if (!ctx.openRewind?.()) throw new Error("no picker")
        },
      },
    ],
    control: {
      rewind: async (index: number) => {
        rewound.push(index)
        agent.messages.splice(index)
      },
    },
  })
  terminal.send("a question\r")
  await shows("an answer")
  await idle()
  terminal.send("/rewind\r")
  await waitFor(() => live().includes("? Rewind the conversation"), "the picker")
  terminal.send("\r")
  await shows("Files were not restored")
  expect(rewound).toEqual([0])
  expect(live()).toContain("› a question")
  terminal.send("\x03")
  terminal.send("\x03")
  await exited
})

const subagentNotice = (text: string) =>
  userMessage(`report: ${text}`, {
    text: "◆ explorer finished ✓ agent · 41s · 12.3k tok",
    origin: "subagent",
  })

for (const mode of ["inline", "fullscreen"] as const) {
  for (const variant of [
    "captured",
    "disabled",
    "extension",
    "conflict",
    "conversation only",
    "cancel",
  ] as const) {
    test(`${mode} rewind picker: ${variant}`, async () => {
      const calls: { index: number; restoreFiles?: boolean }[] = []
      const { terminal, live, all, agent, shows, exited } = await setup([], {
        commands: [],
        cols: 100,
        rows: 32,
        settings: { mode },
        history: [userMessage("change a")],
        control: {
          planRewind: () => ({
            owner: variant === "extension" ? "Restore checkpoint files" : "core",
            enabled: variant !== "disabled",
            restored: 2,
            removed: 1,
            conflicts: variant === "conflict" ? ["/workspace/conflicting.txt"] : [],
            note:
              variant === "disabled"
                ? "Capture is disabled; files will not be restored."
                : "Shell commands and hook formatters are not captured.",
          }),
          rewind: async (index, options) => {
            calls.push({ index, restoreFiles: options?.restoreFiles })
            if (variant === "conflict")
              throw new Error("File restore refused; nothing changed. Conflicts: /workspace/conflicting.txt")
            agent.messages.splice(index)
          },
        },
      })
      terminal.send("\x1b[27u\x1b[27u")
      await waitFor(() => live().includes("? Rewind the conversation"), "message picker")
      terminal.send("\r")
      await waitFor(
        () => live().includes(variant === "disabled" ? "files will not be restored" : "Restore files too?"),
        "file choice",
      )
      if (variant === "disabled") expect(live()).toContain("Capture is disabled")
      else if (variant === "extension") {
        expect(live()).toContain("Restore checkpoint files")
        expect(live()).not.toContain("2 restored")
      } else expect(live()).toContain("2 restored, 1 removed")
      if (variant === "conversation only") terminal.send("\x1b[B")
      if (variant === "cancel") {
        terminal.send("\x1b[27u")
        await waitFor(() => !live().includes("Restore files too?"), "cancelled picker")
        expect(calls).toHaveLength(0)
        expect(agent.messages).toHaveLength(1)
      } else {
        terminal.send("\r")
        await shows(variant === "conflict" ? "Cannot rewind" : "Rewound the conversation")
        expect(calls).toEqual([
          { index: 0, restoreFiles: variant !== "disabled" && variant !== "conversation only" },
        ])
        if (variant === "conflict") {
          expect(agent.messages).toHaveLength(1)
          expect(all()).toContain("conflicting.txt")
        } else if (variant === "disabled" || variant === "conversation only")
          expect(all()).toContain("Files were not restored")
        else if (variant === "extension")
          expect(all().replace(/\s+/g, " ")).toContain("Restore checkpoint files completed")
        else expect(all().replace(/\s+/g, " ")).toContain("Restored 2 files; removed 1 file")
      }
      terminal.send("\x03")
      terminal.send("\x03")
      await exited
    })
  }
}

test("a background result wakes the idle session as a notice line; a draft in the editor stays", async () => {
  const { terminal, live, all, agent, shows, idle, exited } = await setup([
    (req) => ({ text: `reacting to ${lastUserText(req)}` }),
  ])
  terminal.send("half-typed")
  await waitFor(() => live().includes("half-typed"), "the draft")
  agent.expectNotice().deliver(subagentNotice("found it"))
  await shows("reacting to report: found it")
  await idle()
  const text = all()
  expect(text).toContain("└ ✓ explorer finished · agent · 41s · 12.3k tok")
  expect(text).not.toContain("› ◆")
  expect(text).not.toContain("› report")
  expect(live()).toContain("half-typed")
  terminal.send("\x03")
  terminal.send("\x03")
  await exited
})

test("a background result during a turn shows as a notice where it joins, not as steering", async () => {
  const { terminal, live, all, agent, shows, idle, exited } = await setup([
    { text: "looking", delayMs: 60, toolCalls: [{ name: "read", args: { path: "a.ts" } }] },
    (req) => ({ text: `then saw ${lastUserText(req)}` }),
  ])
  terminal.send("go\r")
  await waitFor(() => live().includes(`Enter steer · ${QUEUE_HINT} queue`), "working")
  agent.expectNotice().deliver(subagentNotice("B"))
  await Bun.sleep(20)
  expect(live()).not.toContain("steering ›")
  await shows("then saw report: B")
  await idle()
  const text = all()
  expect(text.indexOf("  └ read")).toBeLessThan(text.indexOf("└ ✓ explorer finished · agent"))
  expect(text.indexOf("└ ✓ explorer finished · agent")).toBeLessThan(text.indexOf("then saw report: B"))
  // A block of the transcript like any other: one blank line before it and after it.
  expect(text).toMatch(/[^\n]\n\n {2}└ ✓ explorer finished · agent · 41s · 12\.3k tok\n\n {2}then saw/)
  terminal.send("\x03")
  await exited
})

test("a background result an interrupt kept waiting shows as pending and joins the next message", async () => {
  const { terminal, live, all, agent, shows, idle, exited } = await setup([
    { text: "0123456789ABCDEFGHIJKLMNOPQRSTUV", delayMs: 30 },
    (req) => ({ text: `now saw ${req.messages.length} messages` }),
  ])
  terminal.send("go\r")
  await shows("01234567")
  agent.expectNotice().deliver(subagentNotice("C"))
  await waitFor(
    () => live().includes("└ ✓ explorer finished · agent · 41s · 12.3k tok · pending"),
    "pending line",
  )
  terminal.send("\x1b[27u")
  await shows("⊘ Interrupted")
  await idle()
  expect(live()).toContain("· pending")
  terminal.send("next\r")
  await shows("now saw")
  await idle()
  expect(live()).not.toContain("· pending")
  const text = all()
  expect(text.indexOf("› next")).toBeLessThan(text.indexOf("└ ✓ explorer finished · agent"))
  expect(agent.waitingNotices).toBe(0)
  terminal.send("\x03")
  await exited
})

test("a failed woken turn shows the countdown to the resend; a message sent first clears it", async () => {
  const { terminal, live, agent, shows, idle, exited } = await setup([
    { error: { message: "provider down" } },
    { text: "answered you" },
  ])
  agent.expectNotice().deliver(subagentNotice("R"))
  await shows("provider down")
  await idle()
  await waitFor(() => /◆ sub-agents' results · pending · retry in (10|9)s/.test(live()), "the countdown")
  expect(agent.noticeRetry?.attempt).toBe(1)
  terminal.send("hello\r")
  await shows("answered you")
  await idle()
  expect(live()).not.toContain("retry in")
  expect(agent.noticeRetry).toBeUndefined()
  terminal.send("\x03")
  await exited
})

test("a held background result woken by a later one leaves no pending line behind", async () => {
  const { terminal, live, agent, shows, idle, exited } = await setup([
    { text: "0123456789ABCDEFGHIJKLMNOPQRSTUV", delayMs: 30 },
    { text: "both seen" },
  ])
  terminal.send("go\r")
  await shows("01234567")
  agent.expectNotice().deliver(subagentNotice("first"))
  await waitFor(() => live().includes("· pending"), "pending line")
  terminal.send("\x1b[27u")
  await shows("⊘ Interrupted")
  await idle()
  agent.expectNotice().deliver(subagentNotice("second"))
  await shows("both seen")
  await idle()
  expect(live()).not.toContain("· pending")
  terminal.send("\x03")
  await exited
})

test("extension dialogs are answered inline: confirm, select and input", async () => {
  const { host, terminal, live, all, shows, idle, exited, agent } = await setup([
    { toolCalls: [{ name: "ask", args: {} }] },
    { text: "thanks" },
  ])
  await host.load((api) => {
    api.registerTool(
      defineTool({
        name: "ask",
        description: "",
        parameters: {},
        execute: async () => {
          const ok = await api.ui.confirm("Proceed?", "It is safe")
          const pick = await api.ui.select("Pick one", ["red", "green", "blue"])
          const name = await api.ui.input("Name", { placeholder: "your name" })
          const cancelled = await api.ui.input("Skip me")
          return textResult(`${ok} ${pick} ${name} ${cancelled}`)
        },
      }),
    )
  }, "asker")
  terminal.send("go\r")
  await waitFor(() => live().includes("? Proceed? (asker)"), "confirm")
  expect(live()).toContain("It is safe")
  // Nothing is preselected: ↓ picks Yes, then Enter answers.
  terminal.send("\x1b[B\r")
  await waitFor(() => live().includes("? Pick one"), "select")
  terminal.send("\x1b[B\r")
  await waitFor(() => live().includes("? Name"), "input")
  terminal.send("Ada\r")
  await waitFor(() => live().includes("? Skip me"), "second input")
  terminal.send("\x1b[27u")
  await shows("thanks")
  await idle()
  const result = agent.messages.find((m) => m.role === "toolResult")
  expect(result?.content[0]).toEqual({ type: "text", text: "true green Ada undefined" })
  expect(all()).toContain("? Pick one ❯ green")
  expect(all()).toContain("? Skip me ❯ cancelled")
  expect(host.ui.pending).toEqual([])
  terminal.send("\x03")
  await exited
})

for (const mode of ["fullscreen", "inline"] as const) {
  test(`both local rewind questions emit waiting and pause progress in ${mode}`, async () => {
    const s = await setup([], {
      settings: { mode },
      env: { WT_SESSION: "1" },
      history: [userMessage("first")],
      commands: [],
      control: {
        rewind: async () => {},
        planRewind: () => ({
          enabled: false,
          owner: "core",
          restored: 0,
          removed: 0,
          conflicts: [],
          note: "Capture disabled",
        }),
      },
    })
    const states: { pending: number; hidden: boolean; change: string }[] = []
    s.bus.subscribe((e) => {
      if (e.type === "ui.waiting") states.push(e.data)
    })
    s.terminal.send("\x1b[O\x1b[27u\x1b[27u")
    await waitFor(() => s.live().includes("Rewind the conversation"), "rewind picker")
    await s.bus.flush()
    expect(states.at(-1)).toEqual({ pending: 1, hidden: false, change: "opened" })
    expect(s.screen.oscs.filter((o) => o.startsWith("9;4;")).at(-1)).toBe("9;4;4;100")
    expect(s.screen.bells).toBe(1)
    s.terminal.send("\r")
    await waitFor(() => s.live().includes("files will not be restored"), "rewind confirmation")
    await s.bus.flush()
    expect(states.filter((e) => e.change === "opened")).toHaveLength(2)
    expect(s.screen.bells).toBe(2)
    s.terminal.send("\x1b[27u")
    await waitFor(() => !s.live().includes("files will not be restored"), "cancel confirmation")
    await s.bus.flush()
    expect(states.at(-1)?.pending).toBe(0)
    expect(s.screen.oscs.filter((o) => o.startsWith("9;4;")).at(-1)).toBe("9;4;0;0")
    s.terminal.send("\x03\x03")
    expect(await s.exited).toBe(0)
  })
}
