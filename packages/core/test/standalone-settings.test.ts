import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { loadSettings } from "../src/config/load.ts"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

test("standalone aliases disambiguate file stems against each other and every reserved package name", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-standalone-collisions-"))
  const home = path.join(dir, "home")
  const cwd = path.join(dir, "project")
  mkdirSync(home)
  const files = ["b", "a"].map((folder) => path.join(cwd, folder, "my extension.ts"))
  for (const file of files) {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      `export default (api) => api.settings.declare({ fields: [{ key: "size", type: "number", label: "Size", default: 2 }] })`,
    )
  }
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
    cwd,
    settingsSources: { home, cwd },
  })
  host.setExtensionSettingsPackageNames(() => ["my-extension", "my-extension-2"])
  try {
    expect(await host.load(() => {}, "package:without-settings", "my-extension-3")).toBe(true)
    for (const file of files) expect(await host.loadFile(file)).toBe(true)
    expect(host.extensionSettingsTargets().map((target) => target.name)).toEqual([
      "my-extension-5",
      "my-extension-4",
    ])
    for (const target of host.extensionSettingsTargets()) {
      const answer = host.ui.extensionSettings(target.name)
      expect(host.ui.pending[0]).toMatchObject({ name: target.identity })
      host.ui.cancel(host.ui.pending[0]!.requestId)
      expect(await answer).toBeUndefined()
    }
    host.unloadAll()
    expect(await host.load(() => {}, "package:without-settings", "my-extension-3")).toBe(true)
    for (const file of files.toReversed()) expect(await host.loadFile(file)).toBe(true)
    expect(host.extensionSettingsTargets().map((target) => target.name)).toEqual([
      "my-extension-4",
      "my-extension-5",
    ])
  } finally {
    host.unloadAll()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("standalone aliases preserve path namespaces and cancel on their owner's unload", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-standalone-settings-"))
  const home = path.join(dir, "home")
  const cwd = path.join(dir, "project")
  mkdirSync(home)
  mkdirSync(cwd)
  const file = path.join(cwd, "my extension.ts")
  const identity = process.platform === "win32" ? file.toLowerCase() : file
  writeFileSync(
    file,
    `export default (api) => api.settings.declare({ fields: [{ key: "size", type: "number", label: "Size", default: 2 }] })`,
  )
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
    cwd,
    settingsSources: { home, cwd },
  })
  try {
    expect(await host.loadFile(file)).toBe(true)
    const answer = host.ui.extensionSettings("my-extension")
    const request = host.ui.pending[0]!
    expect(request).toMatchObject({ kind: "extension-settings", name: identity })
    expect(
      await host.ui.submitExtensionSettings(request.requestId, { values: { size: 4 }, scope: "user" }),
    ).toBeUndefined()
    expect(await answer).toEqual({ values: { size: 4 }, scope: "user" })
    expect(loadSettings({ home, cwd }).settings.extensions).toEqual({ [identity]: { size: 4 } })
    const byPath = host.ui.extensionSettings(file)
    host.ui.cancel(host.ui.pending[0]!.requestId)
    expect(await byPath).toBeUndefined()
    const cancelled = host.ui.extensionSettings("my-extension")
    host.unload(file)
    expect(host.ui.pending).toEqual([])
    expect(await cancelled).toBeUndefined()
    expect(host.extensionSettingsTargets()).toEqual([])
  } finally {
    host.unloadAll()
    rmSync(dir, { recursive: true, force: true })
  }
})
