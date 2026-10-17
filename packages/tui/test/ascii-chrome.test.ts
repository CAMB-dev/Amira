import { expect, test } from "bun:test"
import { emptyUsage, type ViewDefinition } from "@amira/api"
import { ThemeRegistry } from "@amira/core"
import { Editor, key, Spinner, stripAnsi } from "@amira/tui-kit"
import { agentsCommand } from "../../../extensions/agent/src/index.ts"
import { subagentView } from "../../../extensions/agent/src/subagent-view.ts"
import ascii from "../../cli/themes/ascii.json"
import { plain } from "../../tui-kit/test/context.ts"
import { activityRow } from "../src/app/activity-row.ts"
import { DockedView } from "../src/app/dock.ts"
import { Dialog } from "../src/dialog.ts"
import { ExtensionViewer } from "../src/extension-view.ts"
import { FilePicker } from "../src/file-picker.ts"
import { glyphs, setGlyphs } from "../src/glyphs.ts"
import { InputBox } from "../src/input-box.ts"
import { KeyReference } from "../src/key-reference.ts"
import { defaultKeybindings } from "../src/keybindings.ts"
import { modelErrorNotice, noticeLines } from "../src/transcript.ts"
import { setup, waitFor } from "./app-harness.ts"

const chrome = (rows: string[]) => expect(rows.map(stripAnsi).join("\n")).not.toMatch(/[^\p{ASCII}]/u)
const ctx = { ...plain, glyphs: ascii.glyphs }

function themes() {
  const registry = new ThemeRegistry()
  registry.register(ascii, "user")
  return registry
}

test("ASCII spinner and main activity stay ASCII through every frame", () => {
  const before = { ...glyphs }
  const spinner = new Spinner({ label: "Working" })
  try {
    setGlyphs(ascii.glyphs)
    for (let frame = 0; frame < 10; frame++) {
      chrome(spinner.render(80, ctx))
      chrome([
        activityRow(
          {
            label: "responding",
            spinner: spinner.glyph,
            turnMs: 1200,
            tokens: 42,
            rate: 12,
            stop: "esc stop",
            animationMs: 0,
          },
          80,
          ctx,
        ),
      ])
      spinner.tick()
    }
  } finally {
    setGlyphs(before)
  }
})

test("ASCII key reference, scroll range, and model picker use ASCII hints", () => {
  const before = { ...glyphs }
  try {
    setGlyphs(ascii.glyphs)
    const keys = defaultKeybindings()
    const ref = new KeyReference(keys, { onClose: () => {} })
    chrome(ref.render(120, { ...ctx, rows: 300 }))
    ref.render(80, { ...ctx, rows: 16 })
    ref.handleInput(key("pagedown"))
    chrome(ref.render(80, { ...ctx, rows: 16 }))
    const dialog = new Dialog(
      { kind: "select", requestId: "model", title: "Model", options: ["mock/m1", "mock/m2"] },
      () => {},
      keys,
    )
    for (const width of [40, 80]) {
      const rows = dialog.render(width, { ...ctx, rows: 12 })
      expect(rows.join("\n")).toContain("enter choose")
      if (width === 80) expect(rows.join("\n")).toContain("up/down move")
      chrome(rows)
    }
  } finally {
    setGlyphs(before)
  }
})

test("ASCII fullscreen scroll notes cover old and new output", async () => {
  const app = await setup([], {
    cols: 80,
    rows: 24,
    themes: themes(),
    settings: { mode: "fullscreen", theme: "ascii" },
    history: [
      {
        role: "assistant",
        model: { provider: "mock", model: "m1" },
        content: [{ type: "text", text: Array.from({ length: 40 }, (_, i) => `Result ${i}\n\n`).join("") }],
      },
    ],
  })
  try {
    await waitFor(() => app.live().includes("Result 39"), "long transcript")
    app.terminal.send("\x1b[5~")
    await waitFor(() => app.live().includes("rows below"), "scroll note")
    chrome(app.screen.lines)
    app.bus.emit(
      "message.delta",
      { kind: "text", text: "New output\n\n" },
      { sessionId: app.agent.sessionId },
    )
    await waitFor(() => app.live().includes("new output"), "unseen output note")
    chrome(app.screen.lines)
  } finally {
    app.terminal.send("\x03\x03")
    await app.exited
  }
})

test("ASCII agents detail chrome excludes, but preserves, Unicode fixture content", async () => {
  const fixture = "正文 العربية"
  const app = await setup([], {
    cols: 120,
    rows: 30,
    themes: themes(),
    settings: { mode: "fullscreen", theme: "ascii" },
    control: {
      subagents: () => [
        {
          id: "child",
          parentSessionId: "main",
          depth: 1,
          role: "explorer",
          title: "Check files",
          task: "Check files",
          status: "done",
          usage: emptyUsage(),
        },
      ],
      subagentMessages: () => [
        { role: "user", content: [{ type: "text", text: "Check files" }] },
        {
          role: "assistant",
          model: { provider: "mock", model: "m1" },
          content: [{ type: "text", text: fixture }],
        },
      ],
    },
    extensions: [
      (api) => {
        api.registerCommand(agentsCommand())
        api.registerView(subagentView(api))
      },
    ],
  })
  app.host.setSessionControl(app.commands!.control, () => app.agent)
  try {
    app.terminal.send("/agents\r")
    await waitFor(() => app.live().includes("Sub-agents"), "agents list")
    chrome(app.screen.lines)
    app.terminal.send("\r")
    await waitFor(() => app.live().includes(fixture), "agents fixture")
    expect(app.live()).toContain(fixture)
    expect(app.live()).toContain("done")
    chrome(app.screen.lines.map((line) => line.replace(fixture, "")))
  } finally {
    app.terminal.send("\x1b[27u\x03\x03")
    await app.exited
  }
})

for (const placement of ["fullscreen", "dock"] as const) {
  test(`ASCII ${placement} expandable trees preserve fixture text in both disclosure states`, () => {
    const before = { ...glyphs }
    const fixture = "正文 العربية"
    const definition: ViewDefinition = {
      kind: "ascii-tree",
      title: () => "Tree",
      ui: () => ({
        type: "tree",
        id: "tree",
        expanded: "all",
        items: [
          { key: "row", row: [{ kind: "text", text: fixture }], detail: [{ kind: "text", text: "Detail" }] },
        ],
      }),
    }
    const keys = defaultKeybindings()
    const viewer = new ExtensionViewer(
      definition,
      {},
      { placement, keys, state: { focused: "tree", selected: { tree: "row" } } },
    )
    const dock = new DockedView(viewer, keys, 12)
    const render = () =>
      placement === "dock"
        ? dock.render(80, { ...ctx, rows: 30 }, 20)
        : viewer.render(80, { ...ctx, rows: 20 })
    const check = (disclosure: string) => {
      const rows = render()
      expect(rows.join("\n")).toContain(fixture)
      expect(rows.find((row) => row.includes(fixture))).toContain(`${disclosure} ${fixture}`)
      chrome(rows.map((row) => row.replace(fixture, "")))
    }
    try {
      setGlyphs(ascii.glyphs)
      viewer.focused = true
      check("v")
      viewer.handleInput(key("left"))
      check(">")
      viewer.handleInput(key("right"))
      check("v")
    } finally {
      viewer.dispose()
      setGlyphs(before)
    }
  })
}

test("ASCII composer overflow indicators preserve multiline draft content above and below", () => {
  const fixture = "正文 العربية"
  const editor = new Editor({ prompt: "> " })
  editor.setText([fixture, ...Array.from({ length: 10 }, (_, i) => `Line ${i}`), fixture].join("\n"))
  const box = new InputBox(editor)
  const check = () => {
    const rows = box.render(80, { ...ctx, rows: 9 })
    expect(rows.join("\n")).toContain(fixture)
    chrome(rows.map((row) => row.replace(fixture, "")))
    return rows.join("\n")
  }
  const bottom = check()
  expect(editor.hidden.above).toBeGreaterThan(0)
  expect(bottom).toContain("up ")
  for (let row = 0; row < 11; row++) editor.handleInput(key("up"))
  editor.handleInput(key("home"))
  const top = check()
  expect(editor.hidden.below).toBeGreaterThan(0)
  expect(top).toContain("down ")
})

test("ASCII model-error recovery chrome preserves the original error fixture", () => {
  const before = { ...glyphs }
  const fixture = "正文 العربية"
  try {
    setGlyphs(ascii.glyphs)
    const rows = noticeLines(plain.theme, "error", modelErrorNotice(fixture), 120)
    expect(rows.join("\n")).toContain(fixture)
    expect(rows.join("\n")).toContain("up recalls the prompt . /model switches models")
    chrome(rows.map((row) => row.replace(fixture, "")))
  } finally {
    setGlyphs(before)
  }
})

test("ASCII file picker renders indexing frames and truncation without rewriting file fixtures", async () => {
  const before = { ...glyphs }
  const fixture = "src/正文.ts"
  const entries: string[] = []
  const listing = { entries, files: 0, done: false, partial: false }
  let changed = () => {}
  const picker = new FilePicker(
    {
      listing: () => listing,
      subscribe: (listener) => {
        changed = listener
        return () => {}
      },
    },
    () => {},
  )
  try {
    setGlyphs(ascii.glyphs)
    picker.update("@")
    expect(picker.visible).toBe(true)
    for (let frame = 0; frame < 3; frame++) {
      for (const width of [80, 20, 12]) {
        const rows = picker.render(width, ctx)
        expect(rows).toHaveLength(1)
        chrome(rows)
        if (width === 80) expect(rows[0]).toContain("indexing. 0 files")
      }
      await Bun.sleep(90)
    }
    entries.push(fixture)
    listing.files = 1
    changed()
    await waitFor(() => picker.open, "indexed Unicode file")
    const rows = picker.render(80, ctx)
    expect(rows.join("\n")).toContain(fixture)
    expect(rows.join("\n")).toContain("indexing. 1 files")
    chrome(rows.map((row) => row.replace(fixture, "")))
    listing.done = true
    listing.partial = true
    changed()
    await waitFor(() => !picker.render(80, ctx).join("\n").includes("indexing"), "partial listing completion")
    chrome(picker.render(20, ctx).map((row) => row.replace(fixture, "")))
  } finally {
    picker.dispose()
    setGlyphs(before)
  }
})
