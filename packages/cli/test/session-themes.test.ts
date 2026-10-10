import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi } from "@amira/ai"
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
