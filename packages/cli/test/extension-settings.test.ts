import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ExtensionSettingsHandle, Settings } from "@amira/api"
import { loadSettings } from "@amira/core"
import { activePackages, packageScope, writeLock } from "@amira/packages"
import { createCommandHost } from "../src/control.ts"
import { createSession } from "../src/session.ts"

test("CLI exposes standalone settings targets without treating them as packages", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-cli-standalone-settings-"))
  const home = path.join(dir, "home")
  const cwd = path.join(dir, "project")
  mkdirSync(home)
  mkdirSync(cwd)
  const file = path.join(cwd, "my extension.ts")
  writeFileSync(
    file,
    `export default (api) => api.settings.declare({ fields: [{ key: "size", type: "number", label: "Size", default: 2 }] })`,
  )
  const previous = process.env.AMIRA_HOME
  process.env.AMIRA_HOME = home
  let unload: (() => void) | undefined
  try {
    const session = await createSession({ cwd, extensions: [file], noBuiltins: true, catalog: false })
    unload = () => session.host.unloadAll()
    const commands = createCommandHost({ session, cwd, home })
    const admin = commands.control.extensionAdmin!
    expect(admin.list()).toEqual([])
    expect(admin.settings?.()).toEqual([
      {
        name: "my-extension",
        identity: process.platform === "win32" ? file.toLowerCase() : file,
        source: "my extension.ts",
        standalone: true,
      },
    ])
    writeLock(packageScope("user", { home, cwd }).lockFile, {
      lockfileVersion: 1,
      packages: {
        "my-extension": {
          version: "1.0.0",
          source: { type: "git", url: "https://example.invalid/not-fetched" },
          pinned: { commit: "a".repeat(40) },
          installedAt: new Date(0).toISOString(),
        },
      },
    })
    writeFileSync(
      path.join(home, "settings.json"),
      JSON.stringify({ packages: { disabled: ["my-extension"] } }),
    )
    expect(admin.list()[0]).toMatchObject({ name: "my-extension", enabled: false })
    expect(admin.settings?.()[0]).toMatchObject({
      name: "my-extension-2",
      identity: process.platform === "win32" ? file.toLowerCase() : file,
    })
  } finally {
    unload?.()
    if (previous === undefined) delete process.env.AMIRA_HOME
    else process.env.AMIRA_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test.each([false, true])(
  "settings actions follow the user fallback or trusted project precedence (trusted=%s)",
  async (trusted) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "amira-settings-user-fallback-"))
    const home = path.join(dir, "home")
    const cwd = path.join(dir, "project")
    mkdirSync(home)
    mkdirSync(cwd)
    for (const kind of ["user", "project"] as const) {
      const scope = packageScope(kind, { home, cwd })
      const pkg = path.join(scope.dir, "foo")
      mkdirSync(pkg, { recursive: true })
      writeFileSync(
        path.join(pkg, "amira-package.json"),
        JSON.stringify({
          name: "foo",
          version: "1.0.0",
          extensions: ["index.ts"],
          status: kind === "user" ? "wip" : "deprecated",
          statusMessage: `${kind} manifest status`,
          ...(kind === "project" ? { replacedBy: "replacement" } : {}),
        }),
      )
      writeFileSync(
        path.join(pkg, "index.ts"),
        `export default (api) => api.settings.declare({ status: "experimental", fields: [{ key: "size", type: "number", label: "Size", default: 2 }] })`,
      )
      writeLock(scope.lockFile, {
        lockfileVersion: 1,
        packages: {
          foo: {
            version: "1.0.0",
            source: { type: "path", path: pkg },
            pinned: { commit: "a".repeat(40) },
            installedAt: new Date(0).toISOString(),
          },
        },
      })
    }
    if (trusted)
      writeFileSync(
        path.join(home, "settings.json"),
        JSON.stringify({ packages: { trustedProjects: [cwd] } }),
      )
    const previous = process.env.AMIRA_HOME
    process.env.AMIRA_HOME = home
    let unload: (() => void) | undefined
    try {
      const session = await createSession({
        cwd,
        extensions: [],
        noBuiltins: true,
        catalog: false,
        packages: activePackages({ home, cwd }, { project: trusted }),
      })
      unload = () => session.host.unloadAll()
      expect(session.host.extensionSettings.has("foo")).toBe(true)
      const rows = createCommandHost({ session, cwd, home }).control.extensionAdmin!.list()
      expect(rows.find((row) => row.scope === "user")).toMatchObject({ name: "foo", shadowed: true })
      expect(rows.find((row) => row.scope === "project")).toMatchObject({ name: "foo", trusted })
      expect(rows.find((row) => row.scope === "user")?.settings).toBe(trusted ? undefined : true)
      expect(rows.find((row) => row.scope === "project")?.settings).toBe(trusted ? true : undefined)
      const answer = session.host.ui.extensionSettings("foo")
      const request = session.host.ui.pending[0]!
      expect(request).toMatchObject({
        kind: "extension-settings",
        extensionStatus: {
          status: trusted ? "deprecated" : "wip",
          statusMessage: `${trusted ? "project" : "user"} manifest status`,
          ...(trusted ? { replacedBy: "replacement" } : {}),
        },
      })
      expect(
        session.startupEvents.filter(
          (event) => event.type === "extension.notice" && event.data.text.includes("manifest status"),
        ),
      ).toEqual([])
      session.host.ui.cancel(request.requestId)
      await answer
    } finally {
      unload?.()
      if (previous === undefined) delete process.env.AMIRA_HOME
      else process.env.AMIRA_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

const fields = [
  { key: "size", type: "number", label: "Size", default: 2 },
  { key: "enabled", type: "toggle", label: "Enabled", default: true },
] as const

test("CLI page saves use its loader and /reload replaces declarations without retaining listeners", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-cli-extension-settings-"))
  const home = path.join(dir, "home")
  const cwd = path.join(dir, "project")
  mkdirSync(home)
  mkdirSync(path.join(cwd, ".amira"), { recursive: true })
  const previous = process.env.AMIRA_HOME
  process.env.AMIRA_HOME = home
  const flags: Settings = { extensions: { demo: { enabled: false } } }
  const initial = loadSettings({ cwd, home, flags })
  const handles: ExtensionSettingsHandle<typeof fields>[] = []
  const changes: number[] = []
  let unload: (() => void) | undefined
  let reloads = 0
  try {
    const session = await createSession({
      cwd,
      extensions: [],
      noBuiltins: false,
      catalog: false,
      settings: initial.settings,
      settingsLayers: initial.layers,
      reloadSettings: () => {
        reloads++
        return loadSettings({ cwd, home, flags })
      },
      builtins: async () => [
        {
          source: "demo",
          extension: (api) => {
            const handle = api.settings.declare({ fields })
            handles.push(handle)
            handle.onChange((values) => changes.push(values.size))
          },
        },
      ],
    })
    unload = () => session.host.unloadAll()
    expect(handles[0]!.get()).toEqual({ size: 2, enabled: false })
    await session.host.extensionSettings.get("demo")!.save({ size: 4, enabled: true }, "project")
    expect(reloads).toBe(1)
    expect(handles[0]!.get()).toEqual({ size: 4, enabled: false })
    expect(changes).toEqual([4])
    writeFileSync(
      path.join(cwd, ".amira", "settings.json"),
      JSON.stringify({ extensions: { demo: { size: 6 } } }),
    )
    await session.reload()
    expect(reloads).toBe(2)
    expect(handles).toHaveLength(2)
    expect(handles[1]!.get()).toEqual({ size: 6, enabled: false })
    session.host.setSettings({ extensions: { demo: { size: 8 } } })
    expect(changes).toEqual([4, 6, 8])
    expect(handles[0]!.get().size).toBe(6)
  } finally {
    unload?.()
    if (previous === undefined) delete process.env.AMIRA_HOME
    else process.env.AMIRA_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
