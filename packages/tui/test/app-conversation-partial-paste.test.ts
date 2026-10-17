import { expect, test } from "bun:test"
import { closeImageApp, userTexts, waitFor } from "./app-harness.ts"
import { focusFixture } from "./conversation-focus-fixture.ts"

const BEGIN = "\x1b[200~"
const END = "\x1b[201~"

for (const mode of ["fullscreen"] as const) {
  for (const origin of ["main", "owned"] as const) {
    test(`${mode}: partial ${origin} paste never enters the other conversation or replaces its origin draft`, async () => {
      const s = await focusFixture(mode, [{ text: "Target reply" }, { text: "Origin reply" }])
      try {
        s.terminal.send("/design\r")
        await waitFor(() => s.live().includes("main idle"), "initial owned focus")
        if (origin === "main") expect(s.context().unfocusConversation?.()).toBe(true)
        s.terminal.send(`Origin draft${BEGIN}PRIVATE`)
        if (origin === "main") expect(s.context().focusConversation?.(s.conversation)).toBe(true)
        else expect(s.context().unfocusConversation?.()).toBe(true)
        s.terminal.send(`${END}\r`)
        await Bun.sleep(30)
        await s.bus.flush()
        await s.ownedBus.flush()
        expect(userTexts(s.agent)).toEqual(["Main history"])
        expect(userTexts(s.owned)).toEqual(["Design history"])
        expect(s.mock.requests).toHaveLength(0)

        s.terminal.send("Target safe\r")
        const target = origin === "main" ? s.owned : s.agent
        await waitFor(() => userTexts(target).includes("Target safe"), "target accepted safe input")
        await waitFor(() => target.status === "idle", "target reply finished")
        if (origin === "main") expect(s.context().unfocusConversation?.()).toBe(true)
        else expect(s.context().focusConversation?.(s.conversation)).toBe(true)
        s.terminal.send("\r")
        const source = origin === "main" ? s.agent : s.owned
        await waitFor(() => userTexts(source).includes("Origin draft"), "origin draft retained")
        expect(userTexts(source)).toEqual([
          origin === "main" ? "Main history" : "Design history",
          "Origin draft",
        ])
        expect(userTexts(target)).toEqual([
          origin === "main" ? "Design history" : "Main history",
          "Target safe",
        ])
      } finally {
        s.agent.abort()
        s.owned.abort()
        s.context()?.unfocusConversation?.()
        await s.conversation.release()
        await closeImageApp(s)
      }
    })
  }

  test(`${mode}: ownership changes during dispatch discard paste events already parsed from the same chunk`, async () => {
    const s = await focusFixture(mode)
    try {
      s.terminal.send(`/design\r${BEGIN}PRIVATE_MAIN${END}\r`)
      await waitFor(() => s.live().includes("main idle"), "queued paste focus")
      await Bun.sleep(30)
      expect(userTexts(s.owned)).toEqual(["Design history"])
      s.terminal.send(`\x1b[17~${BEGIN}PRIVATE_OWNED${END}\r`)
      await waitFor(() => !s.live().includes("main idle"), "queued paste return")
      await Bun.sleep(30)
      expect(userTexts(s.agent)).toEqual(["Main history"])
      expect(s.mock.requests).toHaveLength(0)
    } finally {
      s.agent.abort()
      s.owned.abort()
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })

  test(`${mode}: partial closing marker remains quarantined after the default 1500ms timeout`, async () => {
    const s = await focusFixture(mode, [{ text: "Safe reply" }])
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("main idle"), "owned focus")
      s.terminal.send(`${BEGIN}PRIVATE\x1b[20`)
      expect(s.context().unfocusConversation?.()).toBe(true)
      await Bun.sleep(1600)
      expect(userTexts(s.agent)).toEqual(["Main history"])
      expect(userTexts(s.owned)).toEqual(["Design history"])
      s.terminal.send("1~\r")
      await Bun.sleep(30)
      expect(s.mock.requests).toHaveLength(0)
      s.terminal.send(`${BEGIN}Safe after timeout${END}\r`)
      await waitFor(() => userTexts(s.agent).includes("Safe after timeout"), "safe paste accepted")
      expect(userTexts(s.agent)).toEqual(["Main history", "Safe after timeout"])
      expect(s.context().focusConversation?.(s.conversation)).toBe(true)
      s.terminal.send("\r")
      await Bun.sleep(30)
      expect(userTexts(s.owned)).toEqual(["Design history"])
    } finally {
      s.agent.abort()
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })

  for (const origin of ["main", "owned"] as const) {
    for (const phase of ["opening", "already-timed-out"] as const) {
      test(`${mode}: ${phase} ${origin} paste retains its origin when focus changes`, async () => {
        const s = await focusFixture(mode, [{ text: "Safe reply" }])
        try {
          s.terminal.send("/design\r")
          await waitFor(() => s.live().includes("main idle"), "owned focus")
          if (origin === "main") expect(s.context().unfocusConversation?.()).toBe(true)
          s.terminal.send(phase === "opening" ? "\x1b[200" : `${BEGIN}ORIGIN_PRIVATE\x1b[20`)
          if (phase === "already-timed-out") {
            await Bun.sleep(1600)
            await waitFor(() => s.live().includes("│ › ORIGIN_PRIVATE"), "timeout stayed on origin")
          }
          if (origin === "main") expect(s.context().focusConversation?.(s.conversation)).toBe(true)
          else expect(s.context().unfocusConversation?.()).toBe(true)
          s.terminal.send(phase === "opening" ? `~PRIVATE_TAIL${END}\r` : "1~\r")
          await Bun.sleep(30)
          expect(userTexts(s.agent)).toEqual(["Main history"])
          expect(userTexts(s.owned)).toEqual(["Design history"])
          expect(s.mock.requests).toHaveLength(0)
          s.terminal.send("Target safe\r")
          const target = origin === "main" ? s.owned : s.agent
          await waitFor(() => userTexts(target).includes("Target safe"), "fresh target keys after real close")
          expect(userTexts(target)).toEqual([
            origin === "main" ? "Design history" : "Main history",
            "Target safe",
          ])
        } finally {
          s.agent.abort()
          s.owned.abort()
          s.context()?.unfocusConversation?.()
          await s.conversation.release()
          await closeImageApp(s)
        }
      })
    }
  }

  test(`${mode}: timed-out paste keys already decoded around F6 cannot cross into main`, async () => {
    const s = await focusFixture(mode, [{ text: "Safe reply" }])
    try {
      s.terminal.send("/design\r")
      await waitFor(() => s.live().includes("main idle"), "owned focus")
      s.terminal.send(`${BEGIN}ORIGIN`)
      await Bun.sleep(1600)
      await waitFor(() => s.live().includes("│ › ORIGIN"), "origin timeout delivery")
      s.terminal.send(`\x1b[17~PRIVATE_TAIL${END}MAIN_SAFE\r`)
      await waitFor(() => userTexts(s.agent).length === 2, "new-owner input after closing marker")
      expect(userTexts(s.agent)).toEqual(["Main history", "MAIN_SAFE"])
      expect(userTexts(s.owned)).toEqual(["Design history"])
      await waitFor(() => s.mock.requests.length === 1, "fresh input reaches only main model")
      expect(s.mock.requests).toHaveLength(1)
    } finally {
      s.agent.abort()
      s.context()?.unfocusConversation?.()
      await s.conversation.release()
      await closeImageApp(s)
    }
  })

  for (const boundary of ["release", "unload"] as const) {
    test(`${mode}: ${boundary} consumes the unfinished owned paste tail before main input resumes`, async () => {
      let release = () => {}
      const s = await focusFixture(mode, [{ text: "Main safe reply" }], "/work/design", {
        extensions: [
          (api) => {
            api.onUnload(() => release())
          },
        ],
      })
      release = () => {
        void s.conversation.release()
      }
      try {
        s.terminal.send("/design\r")
        await waitFor(() => s.live().includes("main idle"), "owned focus")
        s.terminal.send(`${BEGIN}PRIVATE`)
        if (boundary === "release") await s.conversation.release()
        else s.host.unloadAll()
        await waitFor(() => !s.live().includes("main idle"), "released owner returns to main")
        s.terminal.send(`PRIVATE_TAIL\r\x1b[20`)
        s.terminal.send("1~\r")
        await Bun.sleep(30)
        expect(userTexts(s.agent)).toEqual(["Main history"])
        expect(userTexts(s.owned)).toEqual(["Design history"])
        expect(s.mock.requests).toHaveLength(0)
        s.terminal.send("Main safe\r")
        await waitFor(() => userTexts(s.agent).includes("Main safe"), "main input restored")
        expect(userTexts(s.agent)).toEqual(["Main history", "Main safe"])
      } finally {
        s.agent.abort()
        s.context()?.unfocusConversation?.()
        await s.conversation.release()
        await closeImageApp(s)
      }
    })
  }
}
