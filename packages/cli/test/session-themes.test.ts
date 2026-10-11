import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi } from "@amira/ai"
import type { TuiSettings } from "@amira/api"
import { shimmerLabel } from "../../tui/src/app/activity-row.ts"
import { RuntimeThemes } from "../../tui/src/app/themes.ts"
import { plain } from "../../tui-kit/test/context.ts"
import { parseCliArgs } from "../src/args.ts"
import { resolveConfig } from "../src/config.ts"
import { createCommandHost } from "../src/control.ts"
import { createSession, type Session } from "../src/session.ts"

let root: string
let home: string
let cwd: string
let previousHome: string | undefined
let session: Session | undefined

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "amira-session-themes-"))
  home = path.join(root, "home")
  cwd = path.join(root, "project")
  mkdirSync(path.join(home, "themes"), { recursive: true })
  mkdirSync(path.join(cwd, ".amira", "themes"), { recursive: true })
  previousHome = process.env.AMIRA_HOME
  process.env.AMIRA_HOME = home
})

afterEach(async () => {
  if (session) {
    await session.agent.dispose()
    session.host.unloadAll()
    session = undefined
  }
  if (previousHome === undefined) delete process.env.AMIRA_HOME
  else process.env.AMIRA_HOME = previousHome
  rmSync(root, { recursive: true, force: true })
})

test("invalid theme files are startup notices, not session failures", async () => {
  writeFileSync(path.join(home, "themes", "broken.json"), "{invalid")
  writeFileSync(
    path.join(cwd, ".amira", "themes", "bad-color.json"),
    JSON.stringify({ name: "bad", dark: { accent: "blue" } }),
  )
  session = await createSession({ cwd, ai: createAi({ providers: [] }), extensions: [], noBuiltins: true })
  expect(session.host.themes.get("bad")).toBeUndefined()
  expect(session.host.themes.get("amira")).toBeDefined()
  const notices = session.startupEvents.filter((event) => event.type === "extension.notice")
  expect(notices.some((event) => event.data.text.includes("broken.json"))).toBe(true)
  expect(notices.some((event) => event.data.text.includes("accent"))).toBe(true)
})

test("reload re-reads files and removes themes from extensions no longer loaded", async () => {
  const file = path.join(home, "themes", "example.json")
  writeFileSync(file, JSON.stringify({ name: "example", dark: { accent: "#112233" } }))
  let enabled = true
  session = await createSession({
    cwd,
    ai: createAi({ providers: [] }),
    extensions: [],
    noBuiltins: false,
    builtins: async () =>
      enabled
        ? [
            {
              source: "test:theme",
              extension: (api) => {
                api.registerTheme({ name: "example", dark: { accent: "#abcdef" } })
              },
            },
          ]
        : [],
  })
  expect(session.host.themes.get("amira")).toBeDefined()
  expect(session.host.themes.get("example")?.dark?.accent).toBe("#abcdef")
  expect(
    session.startupEvents.some(
      (event) => event.type === "extension.notice" && event.data.text.includes('Theme "example"'),
    ),
  ).toBe(true)
  enabled = false
  writeFileSync(file, JSON.stringify({ name: "example", light: { accent: "#445566" } }))
  await session.reload()
  expect(session.host.themes.get("example")?.dark).toBeUndefined()
  expect(session.host.themes.get("example")?.light?.accent).toBe("#445566")
  rmSync(file)
  await session.reload()
  expect(session.host.themes.get("example")).toBeUndefined()
})

test("saved theme and appearance reach the next session and remain paired through reload", async () => {
  session = await createSession({ cwd, ai: createAi({ providers: [] }), extensions: [], noBuiltins: true })
  const commands = createCommandHost({ session, cwd, home, interactive: true })
  commands.rememberTheme("amber", "light")
  await commands.flushChoices()
  const config = resolveConfig(parseCliArgs([], cwd, {}), home)
  expect(config.settings.tui).toMatchObject({ theme: "amber", themeVariant: "light" })
  await session.agent.dispose()
  session.host.unloadAll()
  const seen: unknown[] = []
  session = await createSession({
    cwd,
    ai: createAi({ providers: [] }),
    extensions: [],
    noBuiltins: false,
    builtins: async () => [
      {
        source: "test:appearance",
        extension: (api) => {
          seen.push(api.settings.tui)
        },
      },
    ],
    settings: config.settings,
    reloadSettings: () => ({ settings: config.settings, layers: config.settingsLayers, warnings: [] }),
  })
  await session.reload()
  expect(seen).toEqual([
    { theme: "amber", themeVariant: "light" },
    { theme: "amber", themeVariant: "light" },
  ])
  expect(session.host.themes.get("amber")).toBeDefined()
})

test("invalid shimmer settings load and produce one startup notice with valid knobs retained", async () => {
  writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify({ tui: { shimmer: { preset: "unknown", width: 100, edge: "bad" } } }),
  )
  const config = resolveConfig(parseCliArgs([], cwd, {}), home)
  expect(config.warnings).toEqual([])
  session = await createSession({
    cwd,
    ai: createAi({ providers: [] }),
    extensions: [],
    noBuiltins: true,
    settings: config.settings,
  })
  const notices = session.startupEvents.flatMap((event) =>
    event.type === "extension.notice" && event.data.text.includes("Settings tui.shimmer") ? [event.data] : [],
  )
  expect(notices).toHaveLength(1)
  expect(notices[0]!.source).toBe("themes")
  expect(notices[0]!.text).toContain("clamped")
})

test("reload reports invalid shimmer once and valid presets produce no warning", async () => {
  const file = path.join(home, "settings.json")
  writeFileSync(file, JSON.stringify({ tui: { shimmer: "pulse" } }))
  const load = () => resolveConfig(parseCliArgs([], cwd, {}), home)
  session = await createSession({
    cwd,
    ai: createAi({ providers: [] }),
    extensions: [],
    noBuiltins: true,
    settings: load().settings,
    reloadSettings: () => {
      const config = load()
      return { settings: config.settings, layers: config.settingsLayers, warnings: config.warnings }
    },
  })
  expect(
    session.startupEvents.some(
      (event) => event.type === "extension.notice" && event.data.text.includes("Settings tui.shimmer"),
    ),
  ).toBe(false)
  const notices: string[] = []
  session.agent.bus.subscribe((event) => {
    if (event.type === "extension.notice" && event.data.text.includes("Settings tui.shimmer"))
      notices.push(event.data.text)
  })
  writeFileSync(file, JSON.stringify({ tui: { shimmer: { period: 1, colors: ["red", "blue"] } } }))
  await session.reload()
  await session.agent.bus.flush()
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain("period clamped")
  expect(notices[0]).toContain("colors")
})

test("session reload pushes all three theme settings after loading the new theme definitions", async () => {
  const file = path.join(home, "settings.json")
  writeFileSync(
    file,
    JSON.stringify({
      tui: { theme: "amira", themeVariant: "dark", shimmer: "off", colorDepth: "truecolor" },
    }),
  )
  const load = () => resolveConfig(parseCliArgs([], cwd, {}), home)
  const initial = load().settings
  let apply: ((settings: TuiSettings | undefined) => void) | undefined
  session = await createSession({
    cwd,
    ai: createAi({ providers: [] }),
    extensions: [],
    noBuiltins: true,
    settings: initial,
    reloadSettings: () => {
      const config = load()
      return { settings: config.settings, layers: config.settingsLayers }
    },
    onSettingsReload: (settings) => apply?.(settings.tui),
  })
  const runtime = new RuntimeThemes(
    {
      agent: session.agent,
      status: session.host.status,
      themes: session.host.themes,
      settings: initial.tui,
      subscribeThemeSettings: (listener) => {
        apply = listener
        return () => {
          apply = undefined
        }
      },
    },
    {},
    { win32InputMode: false, kittyKeyboard: true, synchronizedOutput: false, shiftEnter: true },
  )
  runtime.connect(() => {})
  try {
    writeFileSync(
      path.join(home, "themes", "custom.json"),
      JSON.stringify({ name: "custom", light: { accent: "#010203" }, shimmerEffect: "pulse" }),
    )
    writeFileSync(
      file,
      JSON.stringify({
        tui: {
          theme: "custom",
          themeVariant: "light",
          shimmer: { preset: "wave", edge: "hard", colors: ["#00f000", "#00f000"] },
        },
      }),
    )
    await session.reload()
    expect(runtime.current.name).toBe("custom")
    expect(runtime.current.themeVariant).toBe("light")
    const theme = runtime.current.theme
    expect(theme.accent("A")).toBe("\x1b[38;2;1;2;3mA\x1b[39m")
    expect(shimmerLabel("A", { ...plain, color: true, theme }, 0)).toBe("\x1b[38;2;0;240;0mA\x1b[39m")
    expect(initial.tui?.shimmer).toBe("off")
    writeFileSync(file, "{}")
    await session.reload()
    expect(runtime.current.name).toBe("amira")
    expect(runtime.current.themeVariant).toBe("auto")
    const reset = runtime.current.theme
    expect(shimmerLabel("A", { ...plain, color: true, theme: reset }, 0)).toBe(reset.muted("A"))
  } finally {
    runtime.dispose()
  }
  expect(apply).toBeUndefined()
})

test("an unknown tui.theme name is a startup notice", async () => {
  session = await createSession({
    cwd,
    ai: createAi({ providers: [] }),
    extensions: [],
    noBuiltins: true,
    settings: { tui: { theme: "gone" } },
  })
  const notices = session.startupEvents.filter((event) => event.type === "extension.notice")
  expect(notices.some((event) => event.data.text.includes('Theme "gone"'))).toBe(true)
})
