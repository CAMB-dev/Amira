import { expect, test } from "bun:test"
import type { AnyEvent, ExtensionSettingField, ExtensionSettingsValues } from "@amira/api"
import { EventBus } from "../src/event-bus.ts"
import { type ExtensionSettingsBackend, UiRequests } from "../src/ui-requests.ts"

const fields: ExtensionSettingField[] = [
  { key: "size", type: "number", label: "Size", default: 16, min: 8, max: 32, step: 2 },
  { key: "enabled", type: "toggle", label: "Enabled", default: true },
  { key: "style", type: "choice", label: "Style", default: "plain", options: ["plain", "bold"] },
  { key: "name", type: "text", label: "Name", default: "ok", pattern: "[a-z]+", maxLength: 8 },
  { key: "colour", type: "colour", label: "Colour", default: "#abcdef" },
]

function setup(overrides: Partial<ExtensionSettingsBackend> = {}) {
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  const ui = new UiRequests(bus)
  const saved: { values: ExtensionSettingsValues; scope: "user" | "project" }[] = []
  const backend: ExtensionSettingsBackend = {
    title: "Diagram settings",
    fields,
    get: () => ({ size: 16, enabled: true, style: "plain", name: "ok", colour: "#abcdef" }),
    defaultScope: "project",
    preview: (draft) => ({ lines: [{ kind: "text", text: `Size ${draft.size}` }] }),
    save: (values, scope) => void saved.push({ values, scope }),
    ...overrides,
  }
  ui.setExtensionSettingsAccessor((name) => (name === "diagrams" ? backend : undefined))
  return { bus, events, ui, backend, saved }
}

test("settings requests carry serializable drafts, keep host callbacks private, and save before resolving", async () => {
  let finish!: () => void
  const { bus, events, ui, backend, saved } = setup({
    save: async (values, scope) => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      saved.push({ values, scope })
    },
  })
  const answer = ui.api("commands").extensionSettings("diagrams")
  const request = ui.pending[0]!
  expect(request).toMatchObject({
    kind: "extension-settings",
    name: "diagrams",
    title: "Diagram settings",
    scope: "project",
    source: "commands",
  })
  expect(request).not.toHaveProperty("preview")
  expect(request).not.toHaveProperty("save")
  expect(ui.extensionSettingsBackend(request.requestId)).toBe(backend)
  if (request.kind !== "extension-settings") throw new Error("wrong kind")
  const values = { ...request.values, size: 20 }
  const saving = ui.submitExtensionSettings(request.requestId, { values, scope: "user" })
  expect(ui.pending).toHaveLength(1)
  values.size = 30
  finish()
  expect(await saving).toBeUndefined()
  expect(await answer).toEqual({ values: { ...request.values, size: 20 }, scope: "user" })
  expect(saved[0]?.values.size).toBe(20)
  expect(backend.get().size).toBe(16)
  expect(ui.extensionSettingsBackend(request.requestId)).toBeUndefined()
  await bus.flush()
  const resolved = events.find((event) => event.type === "ui.resolved")
  expect(resolved?.data).not.toHaveProperty("value")
})

test("settings validation rejects invalid answers and persistence failures leave the request open", async () => {
  const { ui, backend, saved } = setup({
    save: async () => {
      throw new Error("read-only settings file")
    },
  })
  const answer = ui.api().extensionSettings("diagrams")
  const id = ui.pending[0]!.requestId
  expect(ui.respond(id, { values: backend.get(), scope: "remote" })).toContain("scope")
  expect(ui.respond(id, { values: { ...backend.get(), size: 17 }, scope: "user" })).toContain("steps")
  expect(ui.respond(id, { values: { ...backend.get(), enabled: "yes" }, scope: "user" })).toContain("Enabled")
  expect(ui.respond(id, { values: { ...backend.get(), style: "missing" }, scope: "user" })).toContain("Style")
  expect(ui.respond(id, { values: { ...backend.get(), name: "0123456789" }, scope: "user" })).toContain(
    "Name",
  )
  expect(ui.respond(id, { values: { ...backend.get(), colour: "red" }, scope: "user" })).toContain("Colour")
  expect(ui.respond(id, { values: { ...backend.get(), extra: true }, scope: "user" })).toContain("unknown")
  expect(await ui.submitExtensionSettings(id, { values: backend.get(), scope: "user" })).toBe(
    "read-only settings file",
  )
  expect(ui.pending).toHaveLength(1)
  expect(saved).toEqual([])
  ui.cancel(id)
  expect(await answer).toBeUndefined()
})

test("Esc/abort/unload discard drafts, including pages opened by another extension", async () => {
  const { ui, saved } = setup()
  const controller = new AbortController()
  const first = ui.api("commands").extensionSettings("diagrams", { signal: controller.signal })
  controller.abort()
  expect(await first).toBeUndefined()
  const second = ui.api("commands").extensionSettings("diagrams")
  ui.cancelExtensionSettings("diagrams")
  expect(await second).toBeUndefined()
  expect(ui.pending).toEqual([])
  expect(saved).toEqual([])
  expect(await ui.api().extensionSettings("unknown", { signal: AbortSignal.abort() })).toBeUndefined()
  expect(() => ui.api().extensionSettings("unknown")).toThrow("no settings")
})

test("RPC settings responses also persist asynchronously and never leak draft values to resolved events", async () => {
  const { ui, backend, saved, bus, events } = setup()
  const answer = ui.api().extensionSettings("diagrams")
  const id = ui.pending[0]!.requestId
  expect(ui.respond(id, { values: backend.get(), scope: "project" })).toBeUndefined()
  expect(await answer).toEqual({ values: backend.get(), scope: "project" })
  expect(saved).toHaveLength(1)
  await bus.flush()
  expect(events.find((event) => event.type === "ui.resolved")?.data).not.toHaveProperty("value")
})

test("settings requests copy only lifecycle fields from the host backend", async () => {
  const metadata = {
    status: "deprecated" as const,
    statusMessage: "Retiring",
    replacedBy: "new-package",
    privateValue: "host-only",
  }
  const { ui } = setup({ extensionStatus: metadata })
  const answer = ui.api("commands").extensionSettings("diagrams")
  const request = ui.pending[0]!
  expect(request).toMatchObject({
    extensionStatus: { status: "deprecated", statusMessage: "Retiring", replacedBy: "new-package" },
  })
  expect(request).not.toHaveProperty("extensionStatus.privateValue")
  metadata.statusMessage = "changed later"
  expect(request).toHaveProperty("extensionStatus.statusMessage", "Retiring")
  ui.cancel(request.requestId)
  await answer
})
