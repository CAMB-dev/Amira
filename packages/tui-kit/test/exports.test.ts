import { expect, test } from "bun:test"
import type { Form, FormFieldView, FormOptions } from "../src/index.ts"

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

test("the public form presentation contract is opt-in", () => {
  const options: Pick<FormOptions, "layout"> = { layout: "card" }
  const action: Pick<FormFieldView, "placement" | "buttonLabel"> = {
    placement: "footer",
    buttonLabel: "Test",
  }
  const card: Form["cardLayout"] = true
  expect({ options, action, card }).toMatchInlineSnapshot(`
    {
      "action": {
        "buttonLabel": "Test",
        "placement": "footer",
      },
      "card": true,
      "options": {
        "layout": "card",
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
