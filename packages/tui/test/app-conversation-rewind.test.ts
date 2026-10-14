import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionControl } from "@amira/api"
import { Agent, AgentTree, SessionStore } from "@amira/core"
import { createCommandHost } from "../../cli/src/control.ts"
import { closeImageApp, exchange, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

const F6 = "\x1b[17~"
const ESC = "\x1b[27u"
const SECRET = "Main private rewind prompt"
const OWNED = "Owned draft stays here"
// Inline preserves previous transcript rows; keep the assistant's reply non-private.
const mainHistory = () => [exchange(SECRET)[0]!, exchange("Public main reply")[1]!]

for (const mode of ["inline", "fullscreen"] as const) {
  for (const action of ["conversation", "files", "fork"] as const) {
    test(`${mode}: real CLI ${action} control preserves prompt recovery through host selection`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "amira-tui-rewind-"))
      const store = SessionStore.create({ cwd: dir, dir })
      for (const message of mainHistory()) store.append({ type: "message", message })
      let control!: SessionControl
      let restored = false
      const s = await focusFixture(mode, [], "/work/design", {
        cwd: dir,
        cols: 120,
        rows: 24,
        session: store,
        history: [],
        control: {
          rewind: (index, options) => control.rewind!(index, options),
          fork: (index, options) => control.fork!(index, options),
          planRewind: (index) => control.planRewind!(index),
        },
      })
      await s.host.load(
        (api) =>
          void api.registerFileRestoration({
            label: "Fixture files",
            restore: async () => {
              restored = true
            },
          }),
        "test:files",
      )
      const cli = createCommandHost({
        cwd: dir,
        session: {
          agent: s.agent,
          ai: s.ai,
          host: s.host,
          tree: new AgentTree({ ai: s.ai, sections: () => [] }),
          startupEvents: [],
          catalogRefresh: Promise.resolve(),
          resume: (selected, model, acquired, options) =>
            selected.withClaim(() => {
              options?.signal?.throwIfAborted()
              const construct = () =>
                new Agent({
                  ai: s.ai,
                  model: model ?? s.agent.model,
                  cwd: dir,
                  bus: s.bus,
                  tools: s.agent.tools,
                  session: selected,
                  systemPrompt: "",
                })
              return acquired ? acquired(construct) : construct()
            }, options),
          reload: async () => {
            throw new Error("unused")
          },
        },
      })
      control = cli.control
      const off = cli.onSwitch((next) => s.commands!.switchTo(next))
      try {
        s.terminal.send(`${ESC}${ESC}`)
        await waitFor(() => s.live().includes("Rewind the conversation"), "stored-session picker")
        s.terminal.send(action === "fork" ? "f" : "\r")
        if (action !== "fork") {
          await waitFor(() => s.live().includes("Restore files too?"), "CLI file confirmation")
          s.terminal.send(action === "files" ? "\r" : "\x1b[B\r")
        }
        await waitFor(() => cli.agent !== s.agent, "real CLI handover")
        await waitFor(() => s.live().includes(`│›${SECRET}`), "real CLI recovered prompt")
        expect(cli.agent.messages).toHaveLength(0)
        expect(s.commands!.agent).toBe(cli.agent)
        expect(cli.agent.sessionId === store.id).toBe(action !== "fork")
        expect(restored).toBe(action === "files")
        expect(s.all()).toContain(action === "fork" ? "Forked the conversation" : "Rewound the conversation")
        if (action !== "fork")
          expect(s.all()).toContain(
            action === "files" ? "Fixture files completed." : "Files were not restored.",
          )
      } finally {
        off()
        await s.conversation.release()
        await closeImageApp(s)
        await cli.agent.dispose("exit")
        s.host.unloadAll()
        await s.host.drain()
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  for (const action of ["conversation", "files", "fork"] as const) {
    test(`${mode}: ${action} switch recovers the selected prompt and success notice`, async () => {
      let switched = false
      let restoreFiles: boolean | undefined
      let index: number | undefined
      const switchRoot = async (at: number) => {
        index = at
        // CLI controls await acquisition/disposal, then notify the host before resolving.
        await Promise.resolve()
        s.commands!.switchTo(next)
        switched = true
      }
      const s = await focusFixture(mode, [], "/work/design", {
        cols: 120,
        rows: 24,
        history: mainHistory(),
        control: {
          rewind: async (at, options) => {
            restoreFiles = options?.restoreFiles
            await switchRoot(at)
          },
          fork: async (at) => switchRoot(at!),
          planRewind: () => ({
            owner: "core",
            enabled: true,
            restored: 1,
            removed: 0,
            conflicts: [],
            note: "Fixture capture",
          }),
        },
      })
      const next = new Agent({
        ai: s.ai,
        model: s.agent.model,
        cwd: s.agent.cwd,
        bus: s.bus,
        ...(action !== "fork" ? { sessionId: s.agent.sessionId } : {}),
      })
      try {
        s.terminal.send(`${ESC}${ESC}`)
        await waitFor(() => s.live().includes("Rewind the conversation"), "main picker")
        s.terminal.send(action === "fork" ? "f" : "\r")
        if (action !== "fork") {
          await waitFor(() => s.live().includes("Restore files too?"), "file confirmation")
          s.terminal.send(action === "files" ? "\r" : "\x1b[B\r")
        }
        await waitFor(() => switched, "operation-owned root switch")
        await Bun.sleep(40)
        expect(s.commands!.agent).toBe(next)
        expect(index).toBe(0)
        expect(restoreFiles).toBe(action === "fork" ? undefined : action === "files")
        expect(s.live()).toContain(`│›${SECRET}`)
        expect(s.all()).toContain(action === "fork" ? "Forked the conversation" : "Rewound the conversation")
        if (action !== "fork")
          expect(s.all()).toContain(action === "files" ? "Restored 1 file" : "Files were not restored.")
      } finally {
        await s.conversation.release()
        await closeImageApp(s)
      }
    })
  }

  for (const unrelated of ["none", "before", "after"] as const) {
    test(`${mode}: async owned switch recovery respects ${unrelated} unrelated replacement and new owned focus`, async () => {
      const before = Promise.withResolvers<void>()
      const after = Promise.withResolvers<void>()
      let started = false
      let switched = false
      let finished = false
      const s = await focusFixture(mode, [], "/work/design", {
        cols: 120,
        rows: 12,
        history: mainHistory(),
        control: {
          rewind: async () => {
            started = true
            await before.promise
            s.commands!.switchTo(next)
            switched = true
            await after.promise
            finished = true
          },
        },
      })
      const makeRoot = () =>
        new Agent({
          ai: s.ai,
          model: s.agent.model,
          cwd: s.agent.cwd,
          bus: s.bus,
          sessionId: s.agent.sessionId,
        })
      const next = makeRoot()
      const other = makeRoot()
      // Both legitimate and unrelated replacements deliberately have the same session ID.
      try {
        s.terminal.send("/design\r")
        await waitFor(() => s.live().includes("Design · fixture"), "owned focus context")
        s.terminal.send(F6)
        await Bun.sleep(40)
        s.terminal.send(`${ESC}${ESC}`)
        await waitFor(() => s.live().includes("Rewind the conversation"), "main picker")
        s.terminal.send("\r")
        await waitFor(() => started, "rewind started")
        if (unrelated === "before") s.commands!.switchTo(other)
        before.resolve()
        await waitFor(() => switched, "expected switch before resolution")
        if (unrelated === "after") s.commands!.switchTo(other)
        s.terminal.send("New root draft")
        await waitFor(() => s.live().includes("│›New root draft"), "replacement draft")
        expect(s.context().focusConversation?.(s.conversation)).toBe(true)
        s.terminal.send(OWNED)
        await waitFor(() => s.live().includes(`│›${OWNED}`), "new owned focus draft")
        after.resolve()
        await waitFor(() => finished, "control completion")
        await Bun.sleep(40)
        expect(s.live()).toContain(`│›${OWNED}`)
        expect(s.live()).not.toContain(SECRET)
        s.terminal.send(F6)
        await Bun.sleep(40)
        if (unrelated === "none") {
          expect(s.live()).toContain("New root draft")
          // Recovery prepends three lines; on a short terminal the caret shows the last.
          s.terminal.send("\x1b[A\x1b[A")
          await waitFor(() => s.live().includes(`│›${SECRET}`), "prepended recovered prompt")
          expect(s.live()).toContain(`│›${SECRET}`)
          expect(s.all()).toContain("Rewound the conversation")
        } else {
          expect(s.live()).toContain("│›New root draft")
          expect(s.live()).not.toContain(`│›${SECRET}`)
          expect(s.all()).not.toContain("Rewound the conversation")
        }
        expect(s.context().focusConversation?.(s.conversation)).toBe(true)
        await waitFor(() => s.live().includes(`│›${OWNED}`), "owned draft preserved after recovery")
      } finally {
        before.resolve()
        after.resolve()
        s.context()?.unfocusConversation?.()
        await s.conversation.release()
        await closeImageApp(s)
      }
    })
  }

  test(`${mode}: deferred double-Esc rewind stays on main while abort drains`, async () => {
    const gate = Promise.withResolvers<void>()
    const s = await focusFixture(
      mode,
      [{ text: "Held main stream", hold: { chunks: 1, until: gate.promise } }],
      "/work/design",
      { cols: 100, rows: 12, history: mainHistory(), control: { rewind: async () => {} } },
    )
    try {
      s.terminal.send("Active main turn\r")
      await s.shows("Held mai")
      s.terminal.send(`${ESC}${ESC}/design\r`)
      await waitFor(() => s.live().includes("Design · fixture"), "owned focus during abort")
      expect(s.agent.status).not.toBe("idle")
      s.terminal.send(OWNED)
      await waitFor(() => s.live().includes(`│›${OWNED}`), "owned draft")
      gate.resolve()
      await s.idle()
      expect(s.live()).not.toContain("Rewind the conversation")
      expect(s.live()).not.toContain(SECRET)
      expect(s.live()).toContain(`│›${OWNED}`)
      expect(s.live()).toContain("1 pending")
      expect(s.live().toLowerCase()).toContain("f6 to answer")
      s.screen.resize(90, 24)
      s.terminal.setSize(90, 24)
      await Bun.sleep(40)
      expect(s.live()).toContain("1 pending")
      s.terminal.send(F6)
      await waitFor(() => s.live().includes("Rewind the conversation"), "deferred main picker")
      expect(s.live()).toContain(SECRET)
      s.terminal.send(ESC)
      expect(s.context().focusConversation?.(s.conversation)).toBe(true)
      await waitFor(() => s.live().includes(`│›${OWNED}`), "owned draft after main picker")
      expect(s.live()).not.toContain("1 pending")
    } finally {
      gate.resolve()
      s.terminal.send(ESC)
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })

  test(`${mode}: retained command openRewind defers without hiding owned input`, async () => {
    const s = await focusFixture(mode, [], "/work/design", {
      cols: 100,
      rows: 12,
      history: mainHistory(),
      control: { rewind: async () => {} },
    })
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("Design · fixture"), "owned focus")
      s.terminal.send(OWNED)
      await waitFor(() => s.live().includes(`│›${OWNED}`), "owned draft")
      expect(s.context().openRewind?.()).toBe(false)
      expect(s.context().openRewind?.()).toBe(false)
      await Bun.sleep(40)
      expect(s.live()).toContain(`│›${OWNED}`)
      expect(s.live()).not.toContain(SECRET)
      expect(s.live()).not.toContain("Rewind the conversation")
      expect(s.live()).toContain("1 pending")
      expect(s.live().toLowerCase()).toContain("f6 to answer")
      s.terminal.send(F6)
      await waitFor(() => s.live().includes("Rewind the conversation"), "retained main picker")
      s.terminal.send(ESC)
      expect(s.context().focusConversation?.(s.conversation)).toBe(true)
      await waitFor(() => s.live().includes(`│›${OWNED}`), "owned draft preserved")
      expect(s.live()).not.toContain("1 pending")
    } finally {
      s.terminal.send(ESC)
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })

  test(`${mode}: asynchronous main rewind restores only the main draft`, async () => {
    const gate = Promise.withResolvers<void>()
    let started = false
    const s = await focusFixture(mode, [], "/work/design", {
      cols: 100,
      rows: 12,
      history: mainHistory(),
      control: {
        rewind: async () => {
          started = true
          await gate.promise
        },
      },
    })
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("Design · fixture"), "owned focus")
      s.terminal.send(F6)
      expect(s.context().openRewind?.()).toBe(true)
      await waitFor(() => s.live().includes("Rewind the conversation"), "main picker")
      s.terminal.send("\r")
      await waitFor(() => started, "rewind started")
      expect(s.context().focusConversation?.(s.conversation)).toBe(true)
      s.terminal.send(OWNED)
      await waitFor(() => s.live().includes(`│›${OWNED}`), "owned draft")
      gate.resolve()
      await Bun.sleep(40)
      expect(s.live()).toContain(`│›${OWNED}`)
      expect(s.live()).not.toContain(SECRET)
      s.terminal.send(F6)
      await waitFor(() => s.live().includes(`│›${SECRET}`), "main draft recovery")
      expect(s.live()).not.toContain(OWNED)
      expect(s.context().focusConversation?.(s.conversation)).toBe(true)
      await waitFor(() => s.live().includes(`│›${OWNED}`), "owned draft preserved")
      expect(s.live()).not.toContain(SECRET)
    } finally {
      gate.resolve()
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })

  test(`${mode}: file confirmation waits if planning changes focus`, async () => {
    let planCalls = 0
    const s = await focusFixture(mode, [], "/work/design", {
      cols: 100,
      rows: 12,
      history: mainHistory(),
      control: {
        rewind: async () => {},
        planRewind: () => {
          planCalls++
          expect(s.context().focusConversation?.(s.conversation)).toBe(true)
          return { owner: "core", enabled: false, restored: 0, removed: 0, conflicts: [], note: "No capture" }
        },
      },
    })
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("Design · fixture"), "owned focus")
      s.terminal.send(F6)
      expect(s.context().openRewind?.()).toBe(true)
      await waitFor(() => s.live().includes("Rewind the conversation"), "main picker")
      s.terminal.send("\r")
      await waitFor(() => planCalls === 1, "plan invoked")
      s.terminal.send(OWNED)
      await waitFor(() => s.live().includes(`│›${OWNED}`), "owned input after planning")
      expect(s.live()).not.toContain("files will not be restored")
      expect(s.live()).toContain("1 pending")
      s.terminal.send(F6)
      await waitFor(() => s.live().includes("files will not be restored"), "main file confirmation")
      expect(planCalls).toBe(1)
      s.terminal.send(ESC)
      expect(s.context().focusConversation?.(s.conversation)).toBe(true)
      await waitFor(() => s.live().includes(`│›${OWNED}`), "owned input preserved")
    } finally {
      s.terminal.send(ESC)
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })

  for (const replacement of [false, true]) {
    test(`${mode}: root switch rejects the old outbox rewind microtask, replacement=${replacement}`, async () => {
      const gate = Promise.withResolvers<void>()
      const s = await focusFixture(
        mode,
        [{ text: "Held main stream", hold: { chunks: 1, until: gate.promise } }],
        "/work/design",
        {
          cols: 100,
          rows: 12,
          history: mainHistory(),
          control: { rewind: async () => {} },
        },
      )
      const next = replacement
        ? new Agent({
            ai: s.ai,
            model: s.agent.model,
            cwd: s.agent.cwd,
            bus: s.bus,
            sessionId: s.agent.sessionId,
          })
        : s.agent
      const off = s.bus.subscribe((event) => {
        if (event.type === "turn.end") s.commands!.switchTo(next)
      })
      try {
        s.terminal.send("Active main turn\r")
        await s.shows("Held mai")
        s.terminal.send(`${ESC}${ESC}`)
        gate.resolve()
        await s.idle()
        expect(s.live()).not.toContain("Rewind the conversation")
        expect(s.all()).not.toContain("Rewind the conversation")
      } finally {
        off()
        gate.resolve()
        await s.conversation.release()
        await closeImageApp(s)
      }
    })

    test(`${mode}: root switch clears pending rewind, replacement=${replacement}`, async () => {
      const s = await focusFixture(mode, [], "/work/design", {
        cols: 100,
        rows: 12,
        history: mainHistory(),
        control: { rewind: async () => {} },
      })
      const next = replacement
        ? new Agent({
            ai: s.ai,
            model: s.agent.model,
            cwd: s.agent.cwd,
            bus: s.bus,
            sessionId: s.agent.sessionId,
          })
        : s.agent
      try {
        s.terminal.send("/design\r")
        await waitFor(() => s.live().includes("Design · fixture"), "owned focus")
        expect(s.context().openRewind?.()).toBe(false)
        s.commands!.switchTo(next)
        await Bun.sleep(40)
        expect(s.live()).not.toContain("Rewind the conversation")
        expect(s.context().focusConversation?.(s.conversation)).toBe(true)
        await waitFor(() => s.live().includes("Design · fixture"), "owned refocus")
        expect(s.live()).not.toContain("1 pending")
        s.terminal.send(F6)
        await Bun.sleep(40)
        expect(s.live()).not.toContain("Rewind the conversation")
      } finally {
        s.context()?.unfocusConversation?.()
        await s.conversation.release()
        await closeImageApp(s)
      }
    })

    test(`${mode}: root switch invalidates in-flight rewind recovery, replacement=${replacement}`, async () => {
      const gate = Promise.withResolvers<void>()
      let started = false
      const s = await focusFixture(mode, [], "/work/design", {
        cols: 100,
        rows: 12,
        history: mainHistory(),
        control: {
          rewind: async () => {
            started = true
            await gate.promise
          },
        },
      })
      const next = replacement
        ? new Agent({
            ai: s.ai,
            model: s.agent.model,
            cwd: s.agent.cwd,
            bus: s.bus,
            sessionId: s.agent.sessionId,
          })
        : s.agent
      try {
        s.terminal.send(`${ESC}${ESC}`)
        await waitFor(() => s.live().includes("Rewind the conversation"), "main picker")
        s.terminal.send("\r")
        await waitFor(() => started, "rewind started")
        s.commands!.switchTo(next)
        s.terminal.send("New root draft")
        await waitFor(() => s.live().includes("│›New root draft"), "new root draft")
        gate.resolve()
        await Bun.sleep(40)
        expect(s.live()).toContain("│›New root draft")
        expect(s.live()).not.toContain(`│›${SECRET}`)
        expect(s.all()).not.toContain("Rewound the conversation")
      } finally {
        gate.resolve()
        await s.conversation.release()
        await closeImageApp(s)
      }
    })
  }
}
