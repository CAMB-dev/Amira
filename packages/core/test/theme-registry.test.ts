import { expect, test } from "bun:test"
import { type AnyEvent, DEFAULT_THEME_GLYPHS, type ExtensionAPI, type ThemeDefinition } from "@amira/api"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ThemeRegistry } from "../src/theme-registry.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

function registry() {
  const notices: { text: string; origin?: string }[] = []
  const themes = new ThemeRegistry((text, origin) => void notices.push({ text, origin }))
  return { themes, notices }
}

test("partial theme palettes keep omitted defaults and normalize RGB hex colors", () => {
  const { themes, notices } = registry()
  themes.register(
    {
      name: "ocean",
      description: "Cool colors",
      dark: { accent: "#ABC", shimmer: "#123456", shimmerEnd: "#FEDCBA" },
      light: { accent: "#123" },
      glyphs: { user: ">", bullets: ["-", "+", "*"] },
    },
    "user",
    "themes/ocean.json",
  )
  expect(themes.get("ocean")).toEqual({
    name: "ocean",
    description: "Cool colors",
    dark: { accent: "#aabbcc", shimmer: "#123456", shimmerEnd: "#fedcba" },
    light: { accent: "#112233" },
    glyphs: { user: ">", bullets: ["-", "+", "*"] },
  })
  expect(themes.get("ocean")!.dark!.fg).toBeUndefined()
  expect(themes.list().map((theme) => theme.name)).toEqual(["ocean"])
  expect(notices).toEqual([])
})

test("unknown theme fields, palette tokens and glyphs are warned about and stripped", () => {
  const { themes, notices } = registry()
  const theme = {
    name: "future",
    unexpected: true,
    dark: { accent: "#abcdef", notAColorToken: "invalid-but-unknown" },
    glyphs: { user: ">", notAGlyph: "anything", toString: "anything" },
  } as const
  themes.register(theme, "package", "package:future")
  expect(themes.get("future")).toEqual({ name: "future", dark: { accent: "#abcdef" }, glyphs: { user: ">" } })
  expect(notices).toHaveLength(4)
  expect(notices.every((notice) => notice.origin === "package:future")).toBe(true)
  expect(notices.map((notice) => notice.text).join("\n")).toContain("unknown dark token")
})

test("malformed definitions are skipped without throwing or disturbing a previous registration", () => {
  const { themes, notices } = registry()
  themes.register({ name: "safe", dark: { accent: "#123456" } }, "built-in")
  const malformed = [
    null,
    [],
    {},
    { name: "" },
    { name: " spaces " },
    { name: "bad\nname" },
    { name: "safe", dark: { accent: "red" } },
    { name: "safe", dark: { accent: "#12345678" } },
    { name: "safe", dark: [] },
    { name: "safe", light: false },
    { name: "safe", description: 42 },
    { name: "safe", glyphs: "not-an-object" },
    {
      get name() {
        throw new Error("getter failed")
      },
    },
  ]
  for (const theme of malformed) {
    let dispose!: () => void
    expect(() => {
      dispose = themes.register(theme as ThemeDefinition, "user")
    }).not.toThrow()
    expect(() => dispose()).not.toThrow()
  }
  expect(themes.list()).toEqual([{ name: "safe", dark: { accent: "#123456" } }])
  expect(notices).toHaveLength(malformed.length)
  expect(notices.every((notice) => notice.text.startsWith("Theme skipped:"))).toBe(true)
})

test("glyph overrides must match the default cell width, including wide emoji and multi-cell text", () => {
  const { themes, notices } = registry()
  themes.register(
    {
      name: "symbols",
      glyphs: {
        user: "界",
        taskDone: "[x]",
        warning: "!!",
        image: ">",
        assistant: "..",
        codeTop: "xx",
        checked: "✓",
        bullets: ["-", "界"],
      },
    },
    "project",
  )
  expect(themes.get("symbols")!.glyphs).toEqual({
    taskDone: "[x]",
    warning: "!!",
    assistant: "..",
    codeTop: "xx",
  })
  expect(notices).toHaveLength(4)
  expect(notices.every((notice) => notice.text.includes("@amira/text-width"))).toBe(true)
  expect(notices.every((notice) => notice.text.includes("Terminal/font widths may differ"))).toBe(true)
  expect(notices.some((notice) => notice.text.includes("bullets[1]"))).toBe(true)
})

test("tool tree glyph overrides allow one/two-cell branches and a one-cell continuation", () => {
  const { themes, notices } = registry()
  themes.register(
    { name: "ascii-tree", glyphs: { treeBranch: "|-", treeLast: "`-", treePipe: "|" } },
    "built-in",
  )
  expect(themes.get("ascii-tree")?.glyphs).toEqual({ treeBranch: "|-", treeLast: "`-", treePipe: "|" })
  expect(notices).toEqual([])
  themes.register(
    { name: "wrong-tree", glyphs: { treeBranch: "---", treeLast: "---", treePipe: "||" } },
    "user",
  )
  expect(themes.get("wrong-tree")?.glyphs).toEqual({})
  expect(notices).toHaveLength(3)
})

test("warning glyphs may change width because their layouts measure the prefix", () => {
  const { themes, notices } = registry()
  themes.register({ name: "ascii-warning", glyphs: { warning: "!" } }, "built-in")
  expect(themes.get("ascii-warning")?.glyphs?.warning).toBe("!")
  expect(notices).toEqual([])
})

test("glyph control sequences, newlines, non-text values and empty bullets are ignored", () => {
  const { themes, notices } = registry()
  themes.register(
    {
      name: "controls",
      glyphs: { user: "\x1b[31m>", assistant: "\n", bullets: [], rule: 5, warning: "\u009b!!" },
    } as unknown as ThemeDefinition,
    "user",
  )
  expect(themes.get("controls")!.glyphs).toEqual({})
  expect(notices).toHaveLength(5)
})

test("all canonical glyph keys accept their default values", () => {
  const { themes, notices } = registry()
  themes.register({ name: "defaults", glyphs: DEFAULT_THEME_GLYPHS }, "built-in")
  expect(themes.get("defaults")!.glyphs).toEqual(DEFAULT_THEME_GLYPHS)
  expect(notices).toEqual([])
})

test("later registration wins, clashes warn, and idempotent disposal restores earlier layers", () => {
  const { themes, notices } = registry()
  const changes: (ThemeDefinition | undefined)[] = []
  const unsubscribe = themes.subscribe(() => void changes.push(themes.get("same")))
  const builtin = themes.register({ name: "same", dark: { accent: "#111111" } }, "built-in")
  const user = themes.register({ name: "same", dark: { accent: "#222222" } }, "user", "user.json")
  const extension = themes.register({ name: "same", dark: { accent: "#333333" } }, "extension", "ext:one")
  expect(themes.list()).toHaveLength(1)
  expect(themes.get("same")!.dark!.accent).toBe("#333333")
  expect(themes.source("same")).toBe("extension")
  user()
  expect(themes.get("same")!.dark!.accent).toBe("#333333")
  extension()
  expect(themes.get("same")!.dark!.accent).toBe("#111111")
  extension()
  expect(changes).toHaveLength(5)
  expect(notices).toHaveLength(2)
  expect(notices[1]!.text).toContain("user.json")
  unsubscribe()
  builtin()
  expect(themes.get("same")).toBeUndefined()
  expect(changes).toHaveLength(5)
})

test("replacing file layers is atomic, removes vanished files and preserves extension overrides", () => {
  const { themes } = registry()
  const old = themes.register({ name: "same", dark: { accent: "#111111" } }, "user")
  themes.register({ name: "vanished" }, "project")
  const extension = themes.register({ name: "same", dark: { accent: "#eeeeee" } }, "extension")
  const snapshots: string[][] = []
  themes.subscribe(() => void snapshots.push(themes.list().map((theme) => theme.name)))
  themes.replaceFiles([
    { theme: { name: "base" }, source: "built-in" },
    { theme: { name: "same", dark: { accent: "#222222" } }, source: "package", origin: "pkg" },
    { theme: { name: "same", dark: { accent: "#333333" } }, source: "project" },
    { theme: { name: "invalid", dark: { accent: "#nope" } }, source: "user" },
  ])
  expect(snapshots).toEqual([["base", "same"]])
  expect(themes.get("same")!.dark!.accent).toBe("#eeeeee")
  expect(themes.get("vanished")).toBeUndefined()
  old()
  expect(snapshots).toHaveLength(1)
  extension()
  expect(themes.get("same")!.dark!.accent).toBe("#333333")
  themes.replaceFiles([])
  expect(themes.list()).toEqual([])
})

test("throwing notices and subscribers cannot make a registration fail", () => {
  const themes = new ThemeRegistry(() => {
    throw new Error("reporting failed")
  })
  themes.subscribe(() => {
    throw new Error("subscriber failed")
  })
  expect(() => themes.register({ name: "bad", dark: { accent: "#invalid" } }, "user")).not.toThrow()
  expect(() => themes.register({ name: "fine" }, "user")).not.toThrow()
  expect(themes.get("fine")).toEqual({ name: "fine" })
})

test("extension themes are cleaned up on unload and failed load, restoring file layers", async () => {
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  host.themes.register({ name: "ocean", dark: { accent: "#111111" } }, "user")
  let api!: ExtensionAPI
  expect(
    await host.load((a) => {
      api = a
      a.registerTheme({ name: "ocean", dark: { accent: "#222222" } })
      a.registerTheme({ name: "only-extension" })
      a.registerTheme({ name: "invalid", dark: { accent: "#invalid" } })
    }, "ext:theme"),
  ).toBe(true)
  expect(host.themes.get("ocean")!.dark!.accent).toBe("#222222")
  expect(host.themes.get("invalid")).toBeUndefined()
  await bus.flush()
  expect(
    events.some(
      (event) =>
        event.type === "extension.notice" &&
        event.data.source === "ext:theme" &&
        event.data.level === "warning",
    ),
  ).toBe(true)
  expect(host.unload("ext:theme")).toBe(true)
  expect(host.themes.get("ocean")!.dark!.accent).toBe("#111111")
  expect(host.themes.get("only-extension")).toBeUndefined()
  api.registerTheme({ name: "after-unload" })
  expect(host.themes.get("after-unload")).toBeUndefined()
  expect(
    await host.load((a) => {
      a.registerTheme({ name: "ocean", dark: { accent: "#333333" } })
      a.registerTheme({ name: "failed" })
      throw new Error("load failed")
    }, "ext:failed"),
  ).toBe(false)
  expect(host.themes.get("ocean")!.dark!.accent).toBe("#111111")
  expect(host.themes.get("failed")).toBeUndefined()
})

test("injected theme registries are exposed by the extension host", async () => {
  const themes = new ThemeRegistry()
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
    themes,
  })
  expect(host.themes).toBe(themes)
  await host.load((api) => void api.registerTheme({ name: "injected" }), "ext:injected")
  expect(themes.get("injected")).toEqual({ name: "injected" })
  host.unloadAll()
  expect(themes.list()).toEqual([])
})

test("tui.theme keywords are rejected as theme names", () => {
  const { themes, notices } = registry()
  for (const name of ["auto", "dark", "light", "terminal"]) themes.register({ name }, "user", `${name}.json`)
  expect(themes.list()).toEqual([])
  expect(notices).toHaveLength(4)
  expect(notices.every((notice) => notice.text.includes("reserved"))).toBe(true)
})
