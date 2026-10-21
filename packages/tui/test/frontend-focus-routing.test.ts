import { expect, test } from "bun:test"
import type { AnyEvent, EventMap } from "@amira/api"
import type { AgentPort } from "@amira/core"
import { Editor } from "@amira/tui-kit"
import {
  createFrontendFocus,
  type FrontendConversationSource,
  type FrontendConversationUpdate,
} from "../src/app/frontend-focus.ts"
import type { createNativeFocus } from "../src/app/native-focus.ts"
import { PromptHistory } from "../src/prompt-history.ts"
import type { TranscriptView } from "../src/view.ts"

function fixture(ancestry = true) {
  const parents = new Map([
    ["main-child", "main"],
    ["main-grandchild", "main-child"],
    ["owned-child", "owned"],
    ["owned-grandchild", "owned-child"],
  ])
  let receive!: (update: FrontendConversationUpdate) => void
  // Use the optional source ancestry seam without requiring callers that only know exact IDs.
  const source: FrontendConversationSource = {
    containsSession(root, id) {
      const seen = new Set<string>()
      while (!seen.has(id)) {
        if (id === root) return true
        seen.add(id)
        const parent = parents.get(id)
        if (!parent) return false
        id = parent
      }
      return false
    },
    async open(ref, listener) {
      receive = listener
      return {
        snapshot: { ...ref, name: "Owned", cwd: "/owned", messages: [], busy: false },
        dispose() {},
      }
    },
  }
  if (!ancestry) delete source.containsSession
  const shown: EventMap["ui.request"][] = []
  const notes: string[] = []
  const resolved: string[] = []
  const view = {
    openSession() {},
    setVisible() {},
    activate() {},
    start() {},
    stop() {},
    requestRender() {},
  } as unknown as TranscriptView
  const native = {
    history: new PromptHistory(),
    unfocus: () => false,
    dispose() {},
  } as unknown as ReturnType<typeof createNativeFocus>
  const port = {
    snapshot: { sessionGeneration: 1, state: { sessionId: "main" } },
  } as unknown as AgentPort
  const focus = createFrontendFocus(native, {
    source,
    port,
    editor: new Editor(),
    mainView: view,
    createView: () => view,
    activate() {},
    prepare() {},
    overlays: {
      detachConversation: () => {
        shown.length = 0
      },
      onUiRequest: (data) => {
        shown.push(data)
      },
      onUiResolved: (data) => {
        resolved.push(data.requestId)
      },
    },
    showNote: (text) => {
      notes.push(text)
    },
    returnKey: () => "F6",
    canFocus: () => true,
  })
  return { focus, shown, notes, resolved, receive: (event: AnyEvent) => receive({ kind: "event", event }) }
}

function request(id: string, sessionId: string, ask = false): AnyEvent {
  const data: EventMap["ui.request"] = ask
    ? {
        kind: "ask",
        requestId: id,
        title: id,
        sessionId,
        questions: [{ question: "Which option?", options: [{ label: "One" }, { label: "Two" }] }],
      }
    : { kind: "confirm", requestId: id, title: id, sessionId, always: true }
  return {
    type: "ui.request",
    sessionId,
    data,
    seq: 1,
    ts: 1,
  }
}

test("a scoped source without an ancestry helper retains child ownership across focus switches", async () => {
  const f = fixture(false)
  try {
    await f.focus.focusReference({ conversationId: "owned", incarnation: "owned-1" })
    f.receive(request("scoped-question", "opaque-child", true))
    expect(f.shown.at(-1)?.sessionId).toBe("opaque-child")
    f.focus.unfocus()
    expect(f.shown).toEqual([])
    await f.focus.focusReference({ conversationId: "owned", incarnation: "owned-1" })
    expect(f.shown.map((data) => [data.requestId, data.sessionId])).toEqual([
      ["scoped-question", "opaque-child"],
    ])
  } finally {
    f.focus.dispose()
  }
})

for (const replay of [false, true]) {
  test(`main descendants' approvals and questions route using ancestry, replay=${replay}`, async () => {
    const f = fixture()
    try {
      const child = request("approval", "main-child")
      expect(f.focus.onUiEvent(child, { replay })).toBe(true)
      expect(f.shown.map((data) => data.requestId)).toEqual(["approval"])
      await f.focus.focusReference({ conversationId: "owned", incarnation: "owned-1" })
      f.focus.onUiEvent(request("question", "main-grandchild", true), { replay })
      expect(f.shown).toEqual([])
      expect(f.notes).toContain("Main needs an answer. Press F6 to return.")
      f.focus.onUiEvent({
        type: "ui.resolved",
        sessionId: "main-child",
        seq: 2,
        ts: 2,
        data: { requestId: "approval", cancelled: false, value: true },
      })
      f.focus.unfocus()
      expect(f.shown.map((data) => data.requestId)).toEqual(["question"])
      expect(f.resolved).toEqual(["approval"])
    } finally {
      f.focus.dispose()
    }
  })

  test(`focused descendants' restored requests retain their actual session, replay=${replay}`, async () => {
    const f = fixture()
    try {
      // A retained grandchild request arrives before this frontend has ever focused its owner.
      f.focus.onUiEvent(request("child-question", "owned-grandchild", true), { replay })
      expect(f.shown).toEqual([])
      await f.focus.focusReference({ conversationId: "owned", incarnation: "owned-1" })
      expect(f.shown.map((data) => [data.requestId, data.sessionId])).toEqual([
        ["child-question", "owned-grandchild"],
      ])
      f.focus.unfocus()
      expect(f.shown).toEqual([])
      await f.focus.focusReference({ conversationId: "owned", incarnation: "owned-1" })
      expect(f.shown.map((data) => data.requestId)).toEqual(["child-question"])
      // Scoped subscription delivery must not falsify descendant ownership metadata.
      f.receive(request("live-child", "owned-child"))
      expect(f.shown.at(-1)?.sessionId).toBe("owned-child")
      f.focus.onUiEvent(request("unrelated", "private-unrelated"), { replay })
      expect(f.shown.map((data) => data.requestId)).toEqual(["child-question", "live-child"])
    } finally {
      f.focus.dispose()
    }
  })
}
