import { expect, test } from "bun:test"
import {
  type Form,
  type FormFieldView,
  type FormOptions,
  type InputReaderOptions,
  type MarkdownStreamOptions,
  type ProcessTerminal,
  renderMarkdown,
} from "../src/index.ts"

test("the public Markdown policy can leave remote file links inert while retaining web links", () => {
  const options: MarkdownStreamOptions = { hyperlinks: "web" }
  const rows = renderMarkdown(
    "[file](file:///remote/secret.ts) [web](https://example.invalid)",
    100,
    undefined,
    options,
  ).join("\n")
  expect(rows).not.toContain("\x1b]8;;file:")
  expect(rows).toContain("\x1b]8;;https://example.invalid")
})

test("input readers expose optional, content-free paste lifecycle notifications", () => {
  const states: boolean[] = []
  const options: InputReaderOptions = { onPasteState: (pending) => states.push(pending) }
  options.onPasteState?.(true)
  options.onPasteState?.(false)
  expect({ options: Object.keys(options), states }).toMatchInlineSnapshot(`
    {
      "options": [
        "onPasteState",
      ],
      "states": [
        true,
        false,
      ],
    }
  `)
})

test("the public theme exports are part of the stable package surface", async () => {
  expect(Object.keys(await import("../src/index.ts")).sort()).toEqual([
    "BaseTerminal",
    "Box",
    "CURSOR_MARKER",
    "Editor",
    "FakeTerminal",
    "Form",
    "FullScreenRenderer",
    "HitRegions",
    "ImageStore",
    "InputParser",
    "InputReader",
    "LineInput",
    "LiveRenderer",
    "MULTI_CLICK_MS",
    "MarkdownStream",
    "PASSIVE_SIGNAL_LISTENER",
    "ProcessTerminal",
    "RESET",
    "ScreenImage",
    "ScrollView",
    "Spinner",
    "Stack",
    "StreamText",
    "TAB_WIDTH",
    "Text",
    "backgroundFromEnv",
    "backgroundOf",
    "bg256",
    "black",
    "blue",
    "bold",
    "chooseImageSupport",
    "chromeGlyphs",
    "closeStyles",
    "colorSupported",
    "colourSwatch",
    "compose",
    "createTheme",
    "cyan",
    "defaultGlyphs",
    "defaultPasteLabel",
    "defaultTheme",
    "detectColorDepth",
    "detectEnv",
    "dim",
    "fg256",
    "fitImage",
    "focusReporting",
    "graphemes",
    "gray",
    "green",
    "imageLabel",
    "imageNodes",
    "inlineImage",
    "inverse",
    "isColorEnabled",
    "isNewlineKey",
    "isSubmitKey",
    "italic",
    "key",
    "keyLabel",
    "magenta",
    "markdownTheme",
    "matchesKey",
    "modes",
    "monoTheme",
    "osc",
    "pendingBlock",
    "pendingImage",
    "placeImage",
    "presentEmoji",
    "progressSupported",
    "red",
    "renderMarkdown",
    "rgb",
    "setColorEnabled",
    "setupTerminalInput",
    "strikethrough",
    "stripAnsi",
    "stripColors",
    "supportsHyperlinks",
    "surfaceTheme",
    "terminalTheme",
    "textKey",
    "textWidth",
    "themeToken",
    "translateMouse",
    "truncateToWidth",
    "underline",
    "validPayload",
    "visibleWidth",
    "white",
    "wrapText",
    "yellow",
  ])
})

test("ProcessTerminal exposes an explicit synchronous emergency stop without a new export", async () => {
  const terminal = (await import("../src/index.ts")).ProcessTerminal
  const emergencyStop: ProcessTerminal["emergencyStop"] = terminal.prototype.emergencyStop
  expect({ method: typeof emergencyStop, parameters: emergencyStop.length }).toMatchInlineSnapshot(`
    {
      "method": "function",
      "parameters": 0,
    }
  `)
})

test("the public form presentation contract is opt-in", () => {
  const options: Pick<FormOptions, "layout" | "summaries"> = {
    layout: "card",
    summaries: [{ id: "endpoint", fields: ["url"], label: "Endpoint", text: "https://example.test" }],
  }
  const action: Pick<FormFieldView, "placement" | "buttonLabel" | "shortcut" | "inline"> = {
    placement: "footer",
    buttonLabel: "Test",
    shortcut: "ctrl+t",
    inline: "models",
  }
  const card: Form["cardLayout"] = true
  expect({ options, action, card }).toMatchInlineSnapshot(`
    {
      "action": {
        "buttonLabel": "Test",
        "inline": "models",
        "placement": "footer",
        "shortcut": "ctrl+t",
      },
      "card": true,
      "options": {
        "layout": "card",
        "summaries": [
          {
            "fields": [
              "url",
            ],
            "id": "endpoint",
            "label": "Endpoint",
            "text": "https://example.test",
          },
        ],
      },
    }
  `)
})

test("the public console-code-page exports stay stable", async () => {
  expect(Object.keys(await import("@amira/tui-kit/console-code-page")).sort()).toEqual([
    "consoleCodePage",
    "createConsoleCodePage",
  ])
})

test("the public math-source exports stay stable", async () => {
  expect(Object.keys(await import("@amira/tui-kit/math-source")).sort()).toEqual([
    "displayMathEnd",
    "displayMathSource",
    "displayMathStart",
    "inlineMathAt",
    "mathCodeLine",
    "mathSources",
  ])
})
