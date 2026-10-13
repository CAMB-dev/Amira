import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ExtensionSettingsHandle } from "@amira/api"
import { EventBus, ExtensionHost, InterceptorRegistry, loadSettings, ToolRegistry } from "@amira/core"
import { defaultTheme, key, stripAnsi } from "@amira/tui-kit"
import { ExtensionSettingsView, uiExtensionSettingsBackend } from "../src/extension-settings-view.ts"

const fields = [
  { key: "size", type: "number", label: "Size", default: 16, min: 8, max: 64, step: 2 },
] as const

test("emoji pasted after a three-character default saves intact at a four-code-point limit", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-settings-unicode-save-"))
  const home = path.join(dir, "home")
  const cwd = path.join(dir, "project")
  mkdirSync(home)
  mkdirSync(cwd)
  const file = path.join(home, "settings.json")
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
    cwd,
    settingsSources: { home, cwd },
  })
  try {
    expect(
      await host.load(
        (api) => {
          api.settings.declare({
            fields: [{ key: "name", type: "text", label: "Name", default: "abc", maxLength: 4 }],
          })
        },
        "sample",
        "sample",
      ),
    ).toBe(true)
    const answer = host.ui.extensionSettings("sample")
    const request = host.ui.pending[0]!
    if (request.kind !== "extension-settings") throw new Error("expected settings page")
    const view = new ExtensionSettingsView(uiExtensionSettingsBackend(host.ui, request), {
      requestRender: () => {},
      onClose: () => {},
    })
    view.handleInput({ type: "paste", text: "🚀" })
    expect(view.values.name).toBe("abc🚀")
    view.handleInput(key("enter"))
    view.handleInput(key("enter"))
    expect(await answer).toEqual({ values: { name: "abc🚀" }, scope: "user" })
    const saved = JSON.parse(readFileSync(file, "utf8")).extensions.sample.name
    expect(saved).toBe("abc🚀")
    expect(saved.isWellFormed()).toBe(true)
    expect(host.extensionSettings.get("sample")!.get().name).toBe("abc🚀")
  } finally {
    host.unloadAll()
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const scope of ["user", "project"] as const) {
  test(`Enter saves the isolated draft to ${scope} settings and notifies the loaded extension`, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "amira-settings-page-save-"))
    const home = path.join(dir, "home")
    const cwd = path.join(dir, "project")
    mkdirSync(home)
    mkdirSync(path.join(cwd, ".amira"), { recursive: true })
    const file = path.join(scope === "user" ? home : path.join(cwd, ".amira"), "settings.json")
    const original =
      '{\n  "shell"  : "auto",\n  "extensions": { "sample": { "size": 16, "other": "keep" } }\n}\n'
    writeFileSync(file, original)
    const loaded = loadSettings({ home, cwd })
    const host = new ExtensionHost({
      bus: new EventBus(),
      interceptors: new InterceptorRegistry(),
      tools: new ToolRegistry(),
      cwd,
      settingsSources: { home, cwd },
      settings: loaded.settings,
      settingsLayers: loaded.layers,
    })
    let handle!: ExtensionSettingsHandle<typeof fields>
    const changes: number[] = []
    let closed = false
    try {
      expect(
        await host.load(
          (api) => {
            handle = api.settings.declare({
              fields,
              preview: (draft) => ({ lines: [{ kind: "text", text: `Sample ${draft.size}` }] }),
            })
            handle.onChange((values) => changes.push(values.size))
          },
          "sample",
          "sample",
        ),
      ).toBe(true)
      const answer = host.ui.extensionSettings("sample")
      const request = host.ui.pending[0]!
      if (request.kind !== "extension-settings") throw new Error("expected settings page")
      expect(request.scope).toBe(scope)
      expect(request.sources?.size).toBe(scope)
      const view = new ExtensionSettingsView(uiExtensionSettingsBackend(host.ui, request), {
        requestRender: () => {},
        onClose: () => {
          closed = true
        },
      })
      const ctx = { theme: defaultTheme, color: true, rows: 22 }
      view.handleInput(key("right"))
      view.render(80, ctx)
      await Bun.sleep(0)
      expect(view.render(80, ctx).map(stripAnsi).join("\n")).toContain("Sample 18")
      expect(handle.get().size).toBe(16)
      expect(changes).toEqual([])
      expect(readFileSync(file, "utf8")).toBe(original)
      view.handleInput(key("enter"))
      expect(readFileSync(file, "utf8")).toBe(original)
      view.handleInput(key("enter"))
      expect(await answer).toEqual({ values: { size: 18 }, scope })
      await Bun.sleep(0)
      expect(closed).toBe(true)
      expect(handle.get().size).toBe(18)
      expect(changes).toEqual([18])
      expect(JSON.parse(readFileSync(file, "utf8")).extensions.sample).toEqual({ size: 18, other: "keep" })
      expect(readFileSync(file, "utf8")).toContain('"shell"  : "auto"')
    } finally {
      host.unloadAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
