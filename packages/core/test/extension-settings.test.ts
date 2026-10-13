import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  type AnyEvent,
  type ExtensionAPI,
  type ExtensionSettingsDeclaration,
  type ExtensionSettingsField,
  type ExtensionSettingsHandle,
  type ExtensionSettingsPreviewContext,
  type ExtensionSettingsValues,
  extensionSettingsDefaults,
  type Settings,
  validateExtensionSetting,
} from "@amira/api"
import { loadSettings } from "../src/config/load.ts"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost, type ExtensionHostOptions } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const fields = [
  { key: "size", type: "number", label: "Size", default: 2, min: 0, max: 10, step: 2 },
  { key: "enabled", type: "toggle", label: "Enabled", default: true },
  {
    key: "style",
    type: "choice",
    label: "Style",
    default: "plain",
    options: ["plain", { value: "bold", label: "Bold" }],
  },
  { key: "name", type: "text", label: "Name", default: "abc", pattern: "[a-z]+", maxLength: 5 },
  { key: "ink", type: "colour", label: "Ink", default: "#AABBCC" },
] as const satisfies readonly ExtensionSettingsField[]

type Values = ExtensionSettingsValues<typeof fields>
let dir: string
let cwd: string
let home: string
let previousHome: string | undefined
let hosts: ExtensionHost[]
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "amira-extension-settings-"))
  cwd = path.join(dir, "project")
  home = path.join(dir, "home")
  mkdirSync(path.join(cwd, ".amira"), { recursive: true })
  mkdirSync(home)
  previousHome = process.env.AMIRA_HOME
  process.env.AMIRA_HOME = home
  hosts = []
})
afterEach(() => {
  for (const host of hosts) host.unloadAll()
  if (previousHome === undefined) delete process.env.AMIRA_HOME
  else process.env.AMIRA_HOME = previousHome
  rmSync(dir, { recursive: true, force: true })
})

function makeHost(options: Partial<ExtensionHostOptions> = {}) {
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
    cwd,
    settingsSources: { cwd, home },
    ...options,
  })
  hosts.push(host)
  return host
}

function settingsFile(scope: "user" | "project" | "project-local") {
  return scope === "user"
    ? path.join(home, "settings.json")
    : path.join(cwd, ".amira", scope === "project" ? "settings.json" : "settings.local.json")
}

function write(scope: "user" | "project" | "project-local", values: Record<string, unknown>) {
  writeFileSync(settingsFile(scope), JSON.stringify({ extensions: { demo: values } }))
}

async function declare(
  host: ExtensionHost,
  declaration: ExtensionSettingsDeclaration<typeof fields> = { fields },
) {
  let handle!: ExtensionSettingsHandle<typeof fields>
  expect(
    await host.load(
      (api) => {
        handle = api.settings.declare(declaration)
      },
      "package:entry",
      "demo",
    ),
  ).toBe(true)
  return handle
}

function capture(bus: EventBus): AnyEvent[] {
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  return events
}

test("declared fields infer typed values and use the host identity without changing settings snapshots", async () => {
  const host = makeHost({ settings: { extensions: { demo: { size: 4 }, other: { size: 8 } } } })
  let api!: ExtensionAPI
  let handle!: ExtensionSettingsHandle<typeof fields>
  await host.load(
    (value) => {
      api = value
      handle = api.settings.declare({
        fields,
        preview: (draft) => {
          const size: number = draft.size
          const enabled: boolean = draft.enabled
          const style: "plain" | "bold" = draft.style
          const name: string = draft.name
          return { lines: [{ kind: "text", text: `${size}/${enabled}/${style}/${name}` }] }
        },
      })
    },
    "package:entry",
    "demo",
  )
  expect(host.extensionSettings.list().map((entry) => entry.name)).toEqual(["demo"])
  expect(host.extensionSettings.has("package:entry")).toBe(false)
  expect(host.extensionSettings.has("other")).toBe(false)
  expect(host.extensionSettings.get("missing")).toBeUndefined()
  expect(host.extensionSettings.get("demo")!.source).toBe("package:entry")
  expect(handle.get()).toEqual({ ...extensionSettingsDefaults(fields), size: 4 })
  expect(Object.isFrozen(handle.get())).toBe(true)
  const choice = host.extensionSettings.get("demo")!.fields.find((field) => field.type === "choice")!
  expect(Object.isFrozen(choice.options)).toBe(true)
  expect(Object.keys(api.settings)).toEqual(["extensions"])
  expect(Object.entries(structuredClone(api.settings))).toEqual([
    ["extensions", { demo: { size: 4 }, other: { size: 8 } }],
  ])
  expect(JSON.parse(JSON.stringify(api.settings))).not.toHaveProperty("declare")
  host.setSettings({ extensions: { demo: { size: 6 } } })
  expect(handle.get().size).toBe(6)
  expect(api.settings.extensions!.demo!.size).toBe(4)
  expect(existsSync(path.join(home, "extension-data"))).toBe(false)
})

test("values and per-field sources follow user, project, local and flag precedence", async () => {
  write("user", { size: 4, name: "user" })
  write("project", { size: 6, enabled: false })
  write("project-local", { size: 8, style: "bold" })
  const loaded = loadSettings({ cwd, home, flags: { extensions: { demo: { size: 10 } } } })
  const host = makeHost({ settings: loaded.settings, settingsLayers: loaded.layers })
  const handle = await declare(host)
  expect(handle.get()).toEqual({ size: 10, enabled: false, style: "bold", name: "user", ink: "#AABBCC" })
  const entry = host.extensionSettings.get("demo")!
  expect(entry.sources.size).toEqual([
    { scope: "user", file: settingsFile("user"), value: 4 },
    { scope: "project", file: settingsFile("project"), value: 6 },
    { scope: "project-local", file: settingsFile("project-local"), value: 8 },
    { scope: "flags", file: "--flags", value: 10 },
  ])
  expect(entry.sources.ink).toEqual([])
  expect(entry.defaultScope).toBe("project")
  expect(Object.isFrozen(entry.sources.size)).toBe(true)
  expect(Object.isFrozen(entry.sources.size![0])).toBe(true)
})

test("invalid file values warn with file and key, and fall back to declared defaults", async () => {
  write("user", { size: 4, enabled: false, style: "bold", name: "ok", ink: "#123456" })
  write("project", { size: 3, enabled: "yes", style: "unknown", name: "123456", ink: "red" })
  const loaded = loadSettings({ cwd, home })
  const bus = new EventBus()
  const events = capture(bus)
  const host = makeHost({ bus, settings: loaded.settings, settingsLayers: loaded.layers })
  const handle = await declare(host)
  await bus.flush()
  expect(handle.get()).toEqual(extensionSettingsDefaults(fields))
  const warnings = events.filter((event) => event.type === "extension.error").map((event) => event.data)
  expect(warnings).toHaveLength(5)
  for (const field of fields) {
    expect(warnings).toContainEqual({
      source: "settings",
      error: `${settingsFile("project")}: "extensions.demo.${field.key}" ${validateExtensionSetting(field, loaded.settings.extensions!.demo![field.key])} (ignored)`,
    })
  }
  expect(host.extensionSettings.get("demo")!.sources.size!.at(-1)!.value).toBe(3)
})

test("unpaired surrogates in files fall back to defaults and cannot be saved", async () => {
  write("user", { name: "abc\ud83d" })
  const loaded = loadSettings({ cwd, home })
  const bus = new EventBus()
  const events = capture(bus)
  const host = makeHost({ bus, settings: loaded.settings, settingsLayers: loaded.layers })
  const handle = await declare(host)
  await bus.flush()
  expect(handle.get().name).toBe("abc")
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "extension.error",
      data: {
        source: "settings",
        error: `${settingsFile("user")}: "extensions.demo.name" must contain well-formed Unicode text (ignored)`,
      },
    }),
  )
  const original = readFileSync(settingsFile("user"), "utf8")
  await expect(
    host.extensionSettings.get("demo")!.save({ ...handle.get(), name: "abc\ud83d" }, "user"),
  ).rejects.toThrow("Unicode")
  expect(readFileSync(settingsFile("user"), "utf8")).toBe(original)
})

test("live changes notify once, isolate listener errors, and resolve all handles before notifying", async () => {
  const bus = new EventBus()
  const events = capture(bus)
  const host = makeHost({ bus })
  const demo = await declare(host)
  let other!: ExtensionSettingsHandle<typeof fields>
  await host.load(
    (api) => {
      other = api.settings.declare({ fields })
    },
    "other",
    "second",
  )
  const changes: Values[] = []
  demo.onChange(() => {
    throw new Error("bad listener")
  })
  const off = demo.onChange((values) => {
    changes.push(values)
    expect(other.get().size).toBe(8)
  })
  host.setSettings({ extensions: { demo: { size: 6 }, second: { size: 8 } } })
  host.setSettings(
    { extensions: { demo: { size: 6 }, second: { size: 8 } } },
    {
      extensions: [{ scope: "user", file: settingsFile("user"), value: { demo: { size: 6 } } }],
    },
  )
  expect(changes.map((value) => value.size)).toEqual([6])
  expect(host.extensionSettings.get("demo")!.sources.size).toHaveLength(1)
  await bus.flush()
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "extension.error",
      data: { source: "package:entry", error: "settings change handler failed: bad listener" },
    }),
  )
  off()
  off()
  host.setSettings({ extensions: { demo: { size: 8 } } })
  expect(changes).toHaveLength(1)
  host.unload("package:entry")
  host.setSettings({ extensions: { demo: { size: 10 } } })
  expect(host.extensionSettings.has("demo")).toBe(false)
  expect(demo.get().size).toBe(8)
  expect(() => demo.onChange(() => {})).toThrow("unloaded")
})

test("async onChange rejections are extension errors, not unhandled process rejections", () => {
  const core = path.resolve(import.meta.dir, "../src/index.ts")
  const script = `
    import { EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from ${JSON.stringify(core)}
    const bus = new EventBus()
    const errors = []
    bus.subscribe((event) => { if (event.type === "extension.error") errors.push(event.data) })
    const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry(),
      cwd: ${JSON.stringify(cwd)}, settingsSources: { cwd: ${JSON.stringify(cwd)}, home: ${JSON.stringify(home)} } })
    await host.load((api) => {
      const settings = api.settings.declare({ fields: [{ key: "size", type: "number", label: "Size", default: 16 }] })
      settings.onChange(async () => { await Promise.resolve(); throw new Error("async listener failed") })
    }, "async-extension", "async-extension")
    host.setSettings({ extensions: { "async-extension": { size: 18 } } })
    await Bun.sleep(0)
    await bus.flush()
    host.unloadAll()
    console.log(JSON.stringify(errors))
  `
  const result = Bun.spawnSync([process.execPath, "-e", script], { cwd, env: process.env, timeout: 30_000 })
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.toString())).toEqual([
    { source: "async-extension", error: "settings change handler failed: async listener failed" },
  ])
})

test("unloading a settings owner cancels pages opened by another caller or without a source", async () => {
  const host = makeHost()
  await declare(host)
  const direct = host.ui.extensionSettings("demo")
  const other = host.ui.extensionSettings("demo", { source: "another-extension" })
  expect(host.ui.pending).toHaveLength(2)
  host.unload("package:entry")
  expect(await direct).toBeUndefined()
  expect(await other).toBeUndefined()
  expect(host.ui.pending).toEqual([])
  expect(existsSync(settingsFile("user"))).toBe(false)
})

test("duplicate declarations and failed loads roll back only their own registration", async () => {
  const host = makeHost()
  await declare(host)
  expect(
    await host.load(
      (api) => {
        api.settings.declare({ fields })
      },
      "duplicate",
      "demo",
    ),
  ).toBe(false)
  expect(host.extensionSettings.get("demo")!.source).toBe("package:entry")
  let failedApi!: ExtensionAPI
  let calls = 0
  expect(
    await host.load(
      (api) => {
        failedApi = api
        api.settings.declare({ fields }).onChange(() => calls++)
        throw new Error("load failed")
      },
      "failed",
      "failed",
    ),
  ).toBe(false)
  expect(host.extensionSettings.has("failed")).toBe(false)
  expect(() => failedApi.settings.declare({ fields })).toThrow("unload")
  host.setSettings({ extensions: { failed: { size: 4 } } })
  expect(calls).toBe(0)
  host.unload("package:entry")
  expect((await declare(host)).get().size).toBe(2)
})

test.each(
  [
    [],
    [{ key: "__proto__", type: "toggle", label: "Bad", default: true }],
    [{ ...fields[0] }, { ...fields[0] }],
    [{ ...fields[0], default: "wrong" }],
    [{ ...fields[0], min: 10, max: 2 }],
    [{ ...fields[0], step: 0 }],
    [{ ...fields[0], step: -1 }],
    [{ ...fields[0], max: Infinity }],
    [{ ...fields[0], label: " " }],
    [{ ...fields[2], options: [] }],
    [{ ...fields[2], options: ["plain", "plain"] }],
    [{ ...fields[2], default: "missing" }],
    [{ ...fields[3], pattern: "[" }],
    [{ ...fields[3], maxLength: -1 }],
    [{ ...fields[3], default: "\ud83d" }],
    [{ ...fields[3], placeholder: 123 }],
    [{ ...fields[4], default: "#ABC" }],
    [{ ...fields[4], default: "blue" }],
    [{ ...fields[4], type: "secret" }],
  ].map((invalid) => ({ invalid })),
)("invalid declarations fail loading without leaving registry entries: %j", async ({ invalid }) => {
  const host = makeHost()
  const fields = invalid as unknown as readonly ExtensionSettingsField[]
  expect(
    await host.load((api) => {
      api.settings.declare({ fields })
    }, "invalid"),
  ).toBe(false)
  expect(host.extensionSettings.list()).toEqual([])
  expect(existsSync(settingsFile("user"))).toBe(false)
})

test.each(["user", "project"] as const)(
  "saving to %s preserves other settings and reloads live values",
  async (scope) => {
    const original =
      '{\n  "shell"  : "auto",\n  "custom": { "keep": [1, 2] },\n  "extensions": { "other": { "keep": true }, "demo": { "unknown": 123 } }\n}\n'
    writeFileSync(settingsFile(scope), original)
    const loaded = loadSettings({ cwd, home })
    const host = makeHost({ settings: loaded.settings, settingsLayers: loaded.layers })
    const handle = await declare(host)
    const seen: Values[] = []
    handle.onChange((values) => seen.push(values))
    const next = { ...handle.get(), size: 8, enabled: false }
    await host.extensionSettings.get("demo")!.save(next, scope)
    expect(JSON.parse(readFileSync(settingsFile(scope), "utf8"))).toEqual({
      shell: "auto",
      custom: { keep: [1, 2] },
      extensions: { other: { keep: true }, demo: { unknown: 123, ...next } },
    })
    expect(readFileSync(settingsFile(scope), "utf8")).toContain('"shell"  : "auto"')
    expect(handle.get()).toEqual(next)
    expect(seen).toEqual([next])
    expect(host.extensionSettings.get("demo")!.sources.size!.at(-1)).toEqual({
      scope,
      file: settingsFile(scope),
      value: 8,
    })
    await host.extensionSettings.get("demo")!.save(next, scope)
    expect(seen).toHaveLength(1)
    expect(existsSync(`${settingsFile(scope)}.lock`)).toBe(false)
  },
)

test("page saves use the supplied flag-aware loader and do not bypass higher precedence", async () => {
  write("project-local", { size: 8 })
  const flags: Settings = { extensions: { demo: { enabled: false } } }
  const loaded = loadSettings({ cwd, home, flags })
  let reloads = 0
  const host = makeHost({
    settings: loaded.settings,
    settingsLayers: loaded.layers,
    reloadSettings: () => {
      reloads++
      return loadSettings({ cwd, home, flags })
    },
  })
  const handle = await declare(host)
  let changes = 0
  handle.onChange(() => changes++)
  await host.extensionSettings.get("demo")!.save({ ...handle.get(), size: 4, enabled: true }, "user")
  expect(reloads).toBe(1)
  expect(handle.get().size).toBe(8)
  expect(handle.get().enabled).toBe(false)
  expect(changes).toBe(0)
  expect(JSON.parse(readFileSync(settingsFile("user"), "utf8")).extensions.demo).toMatchObject({
    size: 4,
    enabled: true,
  })
})

test("invalid saves, unknown keys, missing values, and invalid scopes never write", async () => {
  const host = makeHost()
  const handle = await declare(host)
  const entry = host.extensionSettings.get("demo")!
  for (const values of [
    { ...handle.get(), size: 3 },
    { ...handle.get(), ink: "red" },
    { ...handle.get(), extra: true },
    {},
  ])
    await expect(entry.save(values, "user")).rejects.toThrow()
  for (const scope of ["flags", "project-local"]) {
    await expect(entry.save(handle.get(), scope as "user")).rejects.toThrow("scope")
  }
  expect(existsSync(settingsFile("project-local"))).toBe(false)
  expect(existsSync(settingsFile("user"))).toBe(false)
  host.unload("package:entry")
  await expect(entry.save(handle.get(), "user")).rejects.toThrow("unloaded")
})

test.each(['{"extensions":', "[]", '{"extensions": []}', '{"extensions": {"demo": []}}'])(
  "saving never replaces invalid settings content: %s",
  async (original) => {
    const host = makeHost()
    const handle = await declare(host)
    writeFileSync(settingsFile("user"), original)
    await expect(host.extensionSettings.get("demo")!.save(handle.get(), "user")).rejects.toThrow()
    expect(readFileSync(settingsFile("user"), "utf8")).toBe(original)
  },
)

const context = (signal = new AbortController().signal): ExtensionSettingsPreviewContext => ({
  width: 80,
  images: false,
  maxImageRows: 12,
  theme: { dark: true, foreground: "#fff" },
  signal,
})

test("isolated previews use explicit draft/context and never notify, write, or alter live renderer inputs", async () => {
  const host = makeHost()
  const render = (values: Values) => ({
    lines: [{ kind: "text" as const, text: `${values.size}/${values.ink}` }],
  })
  let seen: Values | undefined
  const handle = await declare(host, {
    fields,
    preview: async (draft, ctx) => {
      seen = draft
      expect(ctx.width).toBe(80)
      expect(ctx.theme.dark).toBe(true)
      expect(ctx.signal.aborted).toBe(false)
      expect(Object.isFrozen(draft)).toBe(true)
      return render(draft)
    },
  })
  const saved = handle.get()
  let changes = 0
  handle.onChange(() => changes++)
  const draft = { ...saved, size: 8, ink: "#123456" }
  const entry = host.extensionSettings.get("demo")!
  expect(await entry.preview!(draft, context())).toEqual(render(draft))
  expect(seen).not.toBe(draft)
  expect(handle.get()).toBe(saved)
  expect(render(handle.get())).toEqual(render(saved))
  expect(changes).toBe(0)
  expect(existsSync(settingsFile("user"))).toBe(false)
  await expect(entry.preview!({ ...draft, size: -1 }, context())).rejects.toThrow("at least")
})

test("aborted and unloaded async previews cannot publish a late result", async () => {
  const host = makeHost()
  let finish!: () => void
  let previewSignal!: AbortSignal
  const handle = await declare(host, {
    fields,
    preview: async (_draft, ctx) => {
      previewSignal = ctx.signal
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return { lines: [{ kind: "text", text: "late" }] }
    },
  })
  const entry = host.extensionSettings.get("demo")!
  const abort = new AbortController()
  const first = entry.preview!(handle.get(), context(abort.signal))
  abort.abort()
  expect(previewSignal.aborted).toBe(true)
  finish()
  await expect(first).rejects.toThrow()
  await expect(entry.preview!(handle.get(), context(abort.signal))).rejects.toThrow()
  const second = entry.preview!(handle.get(), context())
  host.unload("package:entry")
  expect(previewSignal.aborted).toBe(true)
  finish()
  await expect(second).rejects.toThrow()
})
