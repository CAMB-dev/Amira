import { expect, test } from "bun:test"
import { Editor, key } from "@amira/tui-kit"
import { createComposer } from "../src/app/composer.ts"
import { conversationFiles } from "../src/app/conversation-files.ts"
import { fileList } from "../src/file-index.ts"
import { defaultKeybindings } from "../src/keybindings.ts"
import { PromptHistory } from "../src/prompt-history.ts"

const image = { name: "画.png", mimeType: "image/png", data: "iVBORw0KGgo=" }
function fixture(
  readWorkspaceImage: NonNullable<Parameters<typeof createComposer>[0]["readWorkspaceImage"]>,
  clipboard?: Parameters<typeof createComposer>[0]["clipboard"],
) {
  const editor = new Editor({ onSubmit() {} })
  const originalAgent = { cwd: "/srv/Linux:workspace" }
  let agent = originalAgent
  const notes: string[] = []
  let redraws = 0
  const composer = createComposer({
    editor,
    keys: defaultKeybindings({ vscode: false }),
    history: new PromptHistory(),
    agent: () => agent,
    env: {},
    terminal: {},
    files: fileList(["画.png"]),
    localCwd: process.cwd(),
    readWorkspaceImage,
    clipboard,
    showNote: (text) => notes.push(text),
    requestRender() {},
    redraw: () => redraws++,
    redrawTerminal() {},
    runPopup() {},
  })
  return {
    editor,
    composer,
    notes,
    redraws: () => redraws,
    switch: () => {
      agent = { cwd: "/srv/other" }
    },
    restore: () => {
      agent = originalAgent
    },
  }
}

for (const stale of ["none", "edit", "switch", "dispose"] as const) {
  test(`remote @image uses explicit reader and ignores ${stale} stale results`, async () => {
    let finish!: (value: typeof image) => void
    let calls = 0
    const s = fixture(async (cwd, path) => {
      expect(cwd).toBe("/srv/Linux:workspace")
      expect(path).toBe("画.png")
      calls++
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    try {
      s.editor.setText("@画")
      s.composer.syncCompletions()
      expect(s.composer.handleCompletionKey(key("tab"))).toBe(true)
      expect(calls).toBe(1)
      if (stale === "edit") s.editor.setText("new draft")
      if (stale === "switch") s.switch()
      if (stale === "dispose") s.composer.abortClipboard()
      finish(image)
      await Bun.sleep(0)
      expect(s.editor.getParts().some((part) => typeof part !== "string" && "image" in part)).toBe(
        stale === "none",
      )
      if (stale === "edit") expect(s.editor.getText()).toBe("new draft")
    } finally {
      s.composer.abortClipboard()
      s.composer.dispose()
    }
  })
}

test("cancelled A → B → A image read cannot attach to the same restored draft", async () => {
  let finish!: (value: typeof image) => void
  const s = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  try {
    s.editor.setText("@画")
    s.composer.syncCompletions()
    s.composer.handleCompletionKey(key("tab"))
    const parts = s.editor.getParts()
    const before = s.editor.textBeforeCaret()
    // Mirror native focus's resetComposer on both transitions, restoring A's exact object/draft.
    s.composer.cancelClipboard()
    s.composer.resetHistory()
    s.switch()
    s.editor.setText("B draft")
    s.composer.cancelClipboard()
    s.composer.resetHistory()
    s.restore()
    s.editor.setParts(parts)
    expect(s.editor.textBeforeCaret()).toBe(before)
    finish(image)
    await Bun.sleep(0)
    expect(s.editor.getParts()).toEqual(parts)
  } finally {
    s.composer.dispose()
  }
})

function pendingFixture() {
  const reads: ({ signal: AbortSignal } & ReturnType<typeof Promise.withResolvers<typeof image>>)[] = []
  const s = fixture((_cwd, _path, signal) => {
    const pending = Promise.withResolvers<typeof image>()
    reads.push({ signal, ...pending })
    return pending.promise
  })
  const start = () => {
    s.composer.syncCompletions()
    expect(s.composer.handleCompletionKey(key("tab"))).toBe(true)
    return reads.at(-1)!
  }
  s.editor.setText("@画")
  return { ...s, reads, start }
}

for (const cancel of ["cancelClipboard", "resetHistory", "abortClipboard", "dispose"] as const) {
  for (const settle of ["result", "error"] as const) {
    test(`${cancel} aborts workspace reads and ignores late ${settle} without changing the draft or notes`, async () => {
      const s = pendingFixture()
      try {
        const read = s.start()
        s.composer[cancel]()
        expect(read.signal.aborted).toBe(true)
        if (settle === "result") read.resolve(image)
        else read.reject(new Error("stale image error"))
        await Bun.sleep(0)
        expect(s.editor.getParts()).toEqual(["@画"])
        expect(s.notes).toEqual([])
        expect(s.redraws()).toBe(0)
      } finally {
        s.composer.dispose()
      }
    })
  }
}

for (const first of ["old", "new"] as const) {
  for (const stale of ["result", "error"] as const) {
    test(`overlapping workspace reads settle ${first} first and ignore stale ${stale}`, async () => {
      const s = pendingFixture()
      try {
        const old = s.start()
        const next = s.start()
        expect(s.reads).toHaveLength(2)
        expect(old.signal).not.toBe(next.signal)
        expect(old.signal.aborted).toBe(true)
        expect(next.signal.aborted).toBe(false)
        const freshImage = { ...image, name: "fresh.png" }
        const finishOld = () => {
          if (stale === "result") old.resolve(image)
          else old.reject(new Error("out-of-order error"))
        }
        if (first === "old") {
          finishOld()
          await Bun.sleep(0)
          expect(s.editor.getParts()).toEqual(["@画"])
          expect(s.notes).toEqual([])
          expect(s.redraws()).toBe(0)
          expect(next.signal.aborted).toBe(false)
          next.resolve(freshImage)
        } else {
          next.resolve(freshImage)
          await Bun.sleep(0)
          finishOld()
        }
        await Bun.sleep(0)
        expect(s.editor.getParts()).toEqual([{ image: freshImage }])
        expect(s.notes).toHaveLength(1)
        expect(s.notes[0]).toContain("Attached fresh.png")
        expect(s.redraws()).toBe(1)
      } finally {
        s.composer.dispose()
      }
    })
  }
}

for (const settle of ["result", "error"] as const) {
  test(`restoring identical text after an edit ignores the stale workspace ${settle}`, async () => {
    const s = pendingFixture()
    try {
      const read = s.start()
      s.editor.setText("new draft")
      s.editor.setText("@画")
      if (settle === "result") read.resolve(image)
      else read.reject(new Error("edited image error"))
      await Bun.sleep(0)
      expect(s.editor.getParts()).toEqual(["@画"])
      expect(s.notes).toEqual([])
      expect(s.redraws()).toBe(0)
    } finally {
      s.composer.dispose()
    }
  })
}

for (const cancel of ["cancelClipboard", "resetHistory"] as const) {
  test(`${cancel} permits a fresh read while the cancelled one is still settling`, async () => {
    const s = pendingFixture()
    try {
      const old = s.start()
      s.composer[cancel]()
      const next = s.start()
      old.reject(new Error("cancelled read"))
      await Bun.sleep(0)
      expect(next.signal.aborted).toBe(false)
      next.resolve(image)
      await Bun.sleep(0)
      expect(s.editor.getParts()).toEqual([{ image }])
      expect(s.notes).toHaveLength(1)
      expect(s.notes[0]).toContain("Attached")
    } finally {
      s.composer.dispose()
    }
  })
}

for (const settle of ["result", "error"] as const) {
  test(`moving the caret ignores stale workspace ${settle}`, async () => {
    const s = pendingFixture()
    try {
      const read = s.start()
      s.editor.setCursor({ line: 0, col: 0 })
      if (settle === "result") read.resolve(image)
      else read.reject(new Error("stale caret error"))
      await Bun.sleep(0)
      expect(s.editor.getParts()).toEqual(["@画"])
      expect(s.editor.cursor).toEqual({ line: 0, col: 0 })
      expect(s.notes).toEqual([])
      expect(s.redraws()).toBe(0)
    } finally {
      s.composer.dispose()
    }
  })
}

test("a current workspace failure reports its error and leaves the path intact", async () => {
  const s = pendingFixture()
  try {
    s.start().reject(new Error("Cannot read image"))
    await Bun.sleep(0)
    expect(s.editor.getParts()).toEqual(["@画"])
    expect(s.notes).toEqual(["Cannot read image"])
    expect(s.redraws()).toBe(1)
  } finally {
    s.composer.dispose()
  }
})

for (const extra of [0, 1]) {
  test(`remote images enforce the aggregate 5 MiB boundary (${extra} bytes over)`, async () => {
    const s = pendingFixture()
    try {
      const existing = { ...image, data: Buffer.alloc(3 * 1024 * 1024).toString("base64") }
      const incoming = { ...image, data: Buffer.alloc(2 * 1024 * 1024 + extra).toString("base64") }
      s.editor.setParts([{ image: existing }, "\n@画"])
      s.start().resolve(incoming)
      await Bun.sleep(0)
      expect(s.editor.getParts()).toEqual(
        extra ? [{ image: existing }, "\n@画"] : [{ image: existing }, "\n", { image: incoming }],
      )
      expect(s.notes[0]).toContain(extra ? "5 MB total" : "Attached")
    } finally {
      s.composer.dispose()
    }
  })
}

test("focused Linux paths use host-provided sources without a local file walk", () => {
  let focused = true
  const seen: string[] = []
  let disposed = 0
  const source = conversationFiles(
    fileList(["main.ts"]),
    () => "/srv/工作:tree",
    () => focused,
    (cwd) => {
      seen.push(cwd)
      return {
        ...fileList(["child.ts"]),
        dispose() {
          disposed++
        },
      }
    },
  )
  expect(source.listing().entries).toContain("child.ts")
  expect(source.listing().entries).toContain("child.ts")
  expect(seen).toEqual(["/srv/工作:tree"])
  focused = false
  expect(source.listing().entries).toContain("main.ts")
  source.dispose()
  expect(disposed).toBe(1)
})

test("clipboard reads stay local even while composing for a Linux workspace", async () => {
  let received: string | undefined
  const s = fixture(
    async () => image,
    async (cwd) => {
      received = cwd
      return { type: "image", image }
    },
  )
  try {
    s.composer.handleInput(key("v", { ctrl: true }))
    await Bun.sleep(0)
    expect(received).toBe(process.cwd())
    expect(s.editor.getParts()).toEqual([{ image }])
  } finally {
    s.composer.dispose()
  }
})
