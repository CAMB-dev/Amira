import { expect, test } from "bun:test"
import { userMessage } from "@amira/ai"
import { defineTool, textResult } from "@amira/api"
import commandsExtension from "../../../extensions/commands/src/index.ts"
import { lastUserText, QUEUE_HINT, setup, waitFor } from "./app-harness.ts"

for (const mode of ["fullscreen", "inline"] as const) {
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
  userMessage(`report: ${text}`, { text: `◆ explorer finished · 41s · 12.3k tok`, origin: "subagent" })

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
  expect(text).toContain("◆ explorer finished · 41s · 12.3k tok")
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
  expect(text.indexOf("● read")).toBeLessThan(text.indexOf("◆ explorer finished"))
  expect(text.indexOf("◆ explorer finished")).toBeLessThan(text.indexOf("then saw report: B"))
  // A block of the transcript like any other: one blank line before it and after it.
  expect(text).toMatch(/[^\n]\n\n◆ explorer finished · 41s · 12\.3k tok\n\n {2}then saw/)
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
  await waitFor(() => live().includes("◆ explorer finished · 41s · 12.3k tok · pending"), "pending line")
  terminal.send("\x1b[27u")
  await shows("⊘ Interrupted")
  await idle()
  expect(live()).toContain("· pending")
  terminal.send("next\r")
  await shows("now saw")
  await idle()
  expect(live()).not.toContain("· pending")
  const text = all()
  expect(text.indexOf("› next")).toBeLessThan(text.indexOf("◆ explorer finished"))
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
