import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionStore } from "@amira/core"
import { type ClipboardContent, MAX_IMAGE_BYTES } from "../src/image-input.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { PromptHistory } from "../src/prompt-history.ts"
import { closeImageApp, INPUT_PNG, inputImage, paste, setup, testCommands, waitFor } from "./app-harness.ts"

for (const mode of ["fullscreen", "inline"] as const) {
  test(`${mode}: clipboard image-only messages send real image blocks and show placeholders`, async () => {
    const s = await setup([{ text: "Image received." }], {
      acceptsImages: true,
      settings: { mode },
      clipboard: async () => ({ type: "image", image: inputImage() }),
    })
    try {
      s.terminal.send("\x1bv")
      await s.shows("[image 1: photo.png 68 B]")
      s.terminal.send("\r")
      await s.shows("Image received.")
      await s.idle()
      expect(s.mock.requests[0]?.messages[0]?.content).toEqual([{ type: "image", ...inputImage() }])
      expect(s.agent.messages[0]).toEqual({
        role: "user",
        content: [{ type: "image", ...inputImage() }],
        display: { text: "[image 1: photo.png 68 B]" },
      })
    } finally {
      await closeImageApp(s)
    }
  })

  test(`${mode}: pasted image paths and the @ picker attach files; other files stay references`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "amira-app-image-"))
    const file = join(dir, "space name.png")
    writeFileSync(file, Buffer.from(INPUT_PNG, "base64"))
    const s = await setup(
      [{ text: "Path received." }, { text: "Picker received." }, { text: "Text received." }],
      { cwd: dir, acceptsImages: true, settings: { mode }, files: ["space name.png", "code.ts"] },
    )
    try {
      s.terminal.send(paste(`"${file}"`))
      await s.shows("[image 1: space name.png 68 B]")
      s.terminal.send("describe\r")
      await s.shows("Path received.")
      await s.idle()
      expect(s.mock.requests[0]?.messages[0]?.content).toEqual([
        { type: "image", ...inputImage("space name.png") },
        { type: "text", text: "describe" },
      ])
      s.terminal.send("@space")
      await waitFor(() => s.live().includes("❯ space name.png"), "picker file")
      s.terminal.send("\t")
      await waitFor(
        () => s.live().split("╭").at(-1)!.includes("[image 1: space name.png 68 B]"),
        "picker attachment",
      )
      s.terminal.send("\r")
      await s.shows("Picker received.")
      await s.idle()
      expect(s.agent.messages.filter((m) => m.role === "user")[1]?.content).toEqual([
        { type: "image", ...inputImage("space name.png") },
      ])
      s.terminal.send("@code")
      await waitFor(() => s.live().includes("❯ code.ts"), "text file")
      s.terminal.send("\t\r")
      await s.shows("Text received.")
      await s.idle()
      expect(s.agent.messages.filter((m) => m.role === "user")[2]?.content).toEqual([
        { type: "text", text: "@code.ts" },
      ])
    } finally {
      await closeImageApp(s)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test(`${mode}: deleting an attachment sends just the remaining text; undo restores its payload`, async () => {
    const s = await setup([{ text: "Text only." }, { text: "Restored image." }], {
      acceptsImages: true,
      settings: { mode },
      clipboard: async () => ({ type: "image", image: inputImage() }),
    })
    try {
      s.terminal.send("text \x1bv")
      await s.shows("[image 1:")
      s.terminal.send("\x7f\r")
      await s.shows("Text only.")
      await s.idle()
      expect(s.mock.requests[0]?.messages[0]?.content).toEqual([{ type: "text", text: "text" }])
      s.terminal.send("\x1bv")
      await waitFor(() => s.live().includes("[image 1: photo.png 68 B]"), "second image")
      s.terminal.send("\x7f\x1a\r")
      await s.shows("Restored image.")
      await s.idle()
      expect(s.agent.messages.filter((m) => m.role === "user")[1]?.content).toEqual([
        { type: "image", ...inputImage() },
      ])
    } finally {
      await closeImageApp(s)
    }
  })

  test(`${mode}: an unsupported model keeps the image draft until the model changes`, async () => {
    const s = await setup([{ text: "Accepted after switch." }], {
      settings: { mode },
      cols: 150,
      clipboard: async () => ({ type: "image", image: inputImage() }),
    })
    try {
      s.terminal.send("\x1bv")
      await s.shows("[image 1:")
      s.terminal.send("\r")
      await s.shows("This model does not support images.")
      expect(s.mock.requests).toHaveLength(0)
      expect(s.agent.messages).toHaveLength(0)
      expect(s.live()).toContain("[image 1: photo.png 68 B]")
      s.agent.setModel({ ...s.agent.model, caps: { ...s.agent.model.caps, images: true } })
      s.terminal.send("\r")
      await s.shows("Accepted after switch.")
      await s.idle()
      expect(s.mock.requests[0]?.messages[0]?.content).toEqual([{ type: "image", ...inputImage() }])
    } finally {
      await closeImageApp(s)
    }
  })

  test(`${mode}: image bytes and placeholders persist and resume after the source file is removed`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "amira-image-session-"))
    const file = join(dir, "photo.png")
    writeFileSync(file, Buffer.from(INPUT_PNG, "base64"))
    const store = SessionStore.create({ cwd: dir, dir })
    const s = await setup([{ text: "Saved image." }], {
      cwd: dir,
      acceptsImages: true,
      settings: { mode },
      session: store,
    })
    try {
      s.terminal.send(paste(file))
      await s.shows("[image 1:")
      s.terminal.send("\r")
      await s.shows("Saved image.")
      await s.idle()
    } finally {
      await closeImageApp(s)
    }
    rmSync(file)
    const resumed = await setup([{ text: "Still have it." }], {
      cwd: dir,
      acceptsImages: true,
      settings: { mode },
      session: SessionStore.open(store.file),
    })
    try {
      await resumed.shows("[image 1: photo.png 68 B]")
      resumed.terminal.send("describe again\r")
      await resumed.shows("Still have it.")
      await resumed.idle()
      expect(resumed.mock.requests[0]?.messages[0]?.content).toEqual([{ type: "image", ...inputImage() }])
    } finally {
      await closeImageApp(resumed)
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("clipboard keybindings can be configured and do not affect bracketed text paste", async () => {
  let reads = 0
  const keys = new Keybindings({ ...defaultKeys({ vscode: false }), "paste.image": ["alt+x"] })
  const s = await setup([{ text: "Text kept." }], {
    acceptsImages: true,
    keybindings: keys,
    clipboard: async () => {
      reads++
      return { type: "text", text: "clipboard " }
    },
  })
  try {
    s.terminal.send("\x1bx")
    await waitFor(() => s.live().includes("clipboard "), "clipboard text")
    s.terminal.send(`${paste("bracketed\ntext")}\r`)
    await s.shows("Text kept.")
    await s.idle()
    expect(reads).toBe(1)
    expect(s.mock.requests[0]?.messages[0]?.content).toEqual([
      { type: "text", text: "clipboard bracketed\ntext" },
    ])
  } finally {
    await closeImageApp(s)
  }
})

test("empty bracketed paste stays empty; dedicated paste keys attach images and report missing tools", async () => {
  let reads = 0
  const s = await setup([], {
    acceptsImages: true,
    cols: 120,
    clipboard: async () => {
      if (++reads === 1) throw new Error("Image paste needs wl-paste or xclip; neither was found.")
      return { type: "image", image: inputImage() }
    },
  })
  try {
    s.terminal.send("\x16")
    await s.shows("Image paste needs wl-paste or xclip")
    s.terminal.send(paste(""))
    await Bun.sleep(30)
    expect(reads).toBe(1)
    s.terminal.send("\x1bv")
    await s.shows("[image 1:")
    expect(reads).toBe(2)
  } finally {
    await closeImageApp(s)
  }
})

test("submission waits for a pending clipboard read and keeps the typed draft", async () => {
  let resolve!: (v: ClipboardContent) => void
  const pending = new Promise<ClipboardContent>((r) => {
    resolve = r
  })
  const s = await setup([{ text: "Both received." }], {
    acceptsImages: true,
    cols: 120,
    clipboard: () => pending,
  })
  try {
    s.terminal.send("look\x1bv\r")
    await s.shows("Clipboard paste is still loading.")
    expect(s.mock.requests).toHaveLength(0)
    resolve({ type: "image", image: inputImage() })
    await s.shows("[image 1:")
    s.terminal.send("\r")
    await s.shows("Both received.")
    await s.idle()
    expect(s.mock.requests[0]?.messages[0]?.content).toEqual([
      { type: "text", text: "look" },
      { type: "image", ...inputImage() },
    ])
  } finally {
    await closeImageApp(s)
  }
})

test("clearing a draft cancels a pending clipboard read and discards its late image", async () => {
  let resolve!: (v: ClipboardContent) => void
  let signal: AbortSignal | undefined
  const pending = new Promise<ClipboardContent>((r) => {
    resolve = r
  })
  const s = await setup([{ text: "Fresh draft." }], {
    acceptsImages: true,
    clipboard: (_cwd, s) => {
      signal = s
      return pending
    },
  })
  try {
    s.terminal.send("old draft\x1bv\x03")
    expect(signal?.aborted).toBe(true)
    resolve({ type: "image", image: inputImage() })
    await Bun.sleep(30)
    expect(s.live()).not.toContain("[image 1:")
    s.terminal.send("new draft\r")
    await s.shows("Fresh draft.")
    await s.idle()
    expect(s.mock.requests[0]?.messages[0]?.content).toEqual([{ type: "text", text: "new draft" }])
  } finally {
    await closeImageApp(s)
  }
})

test("the total attachment size is capped and the prior draft is kept", async () => {
  const large = { ...inputImage(), data: Buffer.alloc(3 * 1024 * 1024).toString("base64") }
  const s = await setup([], {
    acceptsImages: true,
    cols: 120,
    clipboard: async () => ({ type: "image", image: large }),
  })
  try {
    s.terminal.send("\x1bv")
    await s.shows("[image 1: photo.png 3072 KB]")
    s.terminal.send("\x1bv")
    await s.shows("limited to 5 MB total")
    expect(s.live()).not.toContain("[image 2:")
    s.terminal.send("\x03")
    expect(s.mock.requests).toHaveLength(0)
  } finally {
    await closeImageApp(s)
  }
})

test("sending a recalled oversized image prompt is refused with the draft retained", async () => {
  const history = new PromptHistory()
  history.add([{ image: { ...inputImage(), data: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64") } }])
  const s = await setup([], { acceptsImages: true, promptHistory: history, cols: 120 })
  try {
    s.terminal.send("\x1b[A\r")
    await s.shows("limited to 5 MB total")
    expect(s.live()).toContain("[image 1: photo.png 5121 KB]")
    expect(s.mock.requests).toHaveLength(0)
  } finally {
    await closeImageApp(s)
  }
})

test("steering and queued images keep their payload through the next model request", async () => {
  for (const how of ["steer", "queue"] as const) {
    const s = await setup(
      [
        { text: "Checking.", delayMs: 50, toolCalls: [{ name: "read", args: { path: "x" } }] },
        { text: "Saw attachment." },
        { text: "Queued attachment." },
      ],
      { acceptsImages: true, cols: 100, clipboard: async () => ({ type: "image", image: inputImage() }) },
    )
    try {
      s.terminal.send("go\r")
      await waitFor(() => s.agent.status === "working", "running turn")
      s.terminal.send("\x1bv")
      await s.shows("[image 1:")
      s.terminal.send(how === "steer" ? "\r" : "\x11")
      await s.shows(how === "steer" ? "Saw attachment." : "Queued attachment.")
      await s.idle()
      expect(
        s.mock.requests
          .at(-1)
          ?.messages.some(
            (m) => m.role === "user" && m.content.some((b) => b.type === "image" && b.data === INPUT_PNG),
          ),
      ).toBe(true)
    } finally {
      await closeImageApp(s)
    }
  }
})

test("dropped steering images return to the editor with the original name and payload", async () => {
  const s = await setup([{ text: "Checking.", delayMs: 200 }, { text: "Recovered attachment." }], {
    acceptsImages: true,
    cols: 100,
    clipboard: async () => ({ type: "image", image: inputImage() }),
  })
  try {
    s.terminal.send("go\r")
    await waitFor(() => s.agent.status === "working", "running turn")
    s.terminal.send("\x1bv")
    await s.shows("[image 1:")
    s.terminal.send("\r")
    await s.shows("steering ›")
    s.agent.abort()
    await s.idle()
    await waitFor(
      () => s.live().split("╭").at(-1)!.includes("[image 1: photo.png 68 B]"),
      "restored attachment",
    )
    s.terminal.send("\r")
    await s.shows("Recovered attachment.")
    await s.idle()
    expect(s.mock.requests.at(-1)?.messages.at(-1)?.content).toEqual([{ type: "image", ...inputImage() }])
  } finally {
    await closeImageApp(s)
  }
})

test("merging queued image messages preserves all attachments and enforces the combined size cap", async () => {
  for (const oversized of [false, true]) {
    let reads = 0
    const s = await setup([{ text: "Checking.", delayMs: 200 }, { text: "Combined attachments." }], {
      acceptsImages: true,
      cols: 120,
      clipboard: async () => ({
        type: "image",
        image: {
          ...inputImage(`${++reads}.png`),
          ...(oversized ? { data: Buffer.alloc(3 * 1024 * 1024).toString("base64") } : {}),
        },
      }),
    })
    try {
      s.terminal.send("go\r")
      await waitFor(() => s.agent.status === "working", "running turn")
      for (const n of [1, 2]) {
        s.terminal.send("\x1bv")
        await waitFor(
          () => s.live().split("╭").at(-1)!.includes(`[image 1: ${n}.png`),
          "queued attachment draft",
        )
        s.terminal.send("\x11")
        await s.shows(`queued › [image 1: ${n}.png`)
      }
      await s.shows(oversized ? "Images in the combined message exceed 5 MB." : "Combined attachments.")
      await s.idle()
      if (oversized) {
        expect(s.mock.requests).toHaveLength(1)
        expect(s.live().split("╭").at(-1)).toContain("[image 1: 1.png")
        expect(s.live().split("╭").at(-1)).toContain("[image 2: 2.png")
      } else {
        expect(
          s.mock.requests
            .at(-1)
            ?.messages.at(-1)
            ?.content.filter((b) => b.type === "image"),
        ).toEqual([
          { type: "image", ...inputImage("1.png") },
          { type: "image", ...inputImage("2.png") },
        ])
      }
    } finally {
      await closeImageApp(s)
    }
  }
})

test("unsupported pasted image formats stay text with a notice, as do missing paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amira-invalid-image-"))
  const file = join(dir, "vector.svg")
  writeFileSync(file, "<svg/>")
  const s = await setup([{ text: "Missing path text." }], { cwd: dir, acceptsImages: true, cols: 100 })
  try {
    s.terminal.send(paste(file))
    await s.shows("Unsupported image format. Use PNG, JPEG, GIF or WebP. Pasted as text.")
    expect(s.live()).not.toContain("[image 1:")
    expect(s.live()).toContain("vector.svg")
    s.terminal.send("\x03")
    s.terminal.send(`${paste("missing.png")}\r`)
    await s.shows("Missing path text.")
    await s.idle()
    expect(s.mock.requests[0]?.messages[0]?.content).toEqual([{ type: "text", text: "missing.png" }])
  } finally {
    await closeImageApp(s)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("images cannot be consumed by slash-command completion or an external text editor", async () => {
  const calls: string[] = []
  const s = await setup([{ text: "Image and command text received." }], {
    acceptsImages: true,
    cols: 120,
    commands: testCommands(calls),
    clipboard: async () => ({ type: "image", image: inputImage() }),
  })
  try {
    s.terminal.send("\x1bv")
    await s.shows("[image 1:")
    s.terminal.send("\x07")
    await s.shows("Remove image attachments before using the external text editor.")
    s.terminal.send("/status\r")
    await s.shows("Image and command text received.")
    await s.idle()
    expect(calls).toEqual([])
    expect(s.mock.requests[0]?.messages[0]?.content).toEqual([
      { type: "image", ...inputImage() },
      { type: "text", text: "/status" },
    ])
  } finally {
    await closeImageApp(s)
  }
})
