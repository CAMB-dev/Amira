import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { SessionControl } from "@amira/api"
import { Agent, EventBus, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { rememberingControl } from "../src/remember-choice.ts"

test("rememberTuiSettings merges tui patch atomically without clobbering unrelated settings", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-tui-settings-"))
  const home = path.join(dir, "home")
  const cwd = path.join(dir, "work")
  try {
    const ai = createAi({
      dialects: [createMockDialect([])],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    })
    const agent = new Agent({
      ai,
      model: ai.model("mock/m1"),
      cwd,
      bus: new EventBus(),
      tools: new ToolRegistry(),
      interceptors: new InterceptorRegistry(),
    })
    const control = {
      setModel: () => {},
      setFastMode: () => {},
      setThinking: () => {},
    } as unknown as SessionControl

    // Pre-populate settings.json with theme and unrelated top-level keys.
    const settingsPath = path.join(home, "settings.json")
    const fs = await import("node:fs")
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(cwd, { recursive: true })
    writeFileSync(
      settingsPath,
      JSON.stringify({ model: "mock/m1", tui: { theme: "amira", bell: true } }, null, 2),
    )

    const remembered = rememberingControl(
      control,
      () => agent,
      cwd,
      home,
      async () => undefined,
    )
    remembered.rememberTuiSettings({ margin: 4, marginRows: 1, clock: "24h" })
    await remembered.flush()

    const saved = JSON.parse(readFileSync(settingsPath, "utf8"))
    expect(saved).toEqual({
      model: "mock/m1",
      tui: {
        theme: "amira",
        bell: true,
        margin: 4,
        marginRows: 1,
        clock: "24h",
      },
    })

    // Deleting a key with undefined removes only that key from tui.
    remembered.rememberTuiSettings({ clock: undefined, margin: 1 })
    await remembered.flush()
    const updated = JSON.parse(readFileSync(settingsPath, "utf8"))
    expect(updated.tui).toEqual({
      theme: "amira",
      bell: true,
      margin: 1,
      marginRows: 1,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
