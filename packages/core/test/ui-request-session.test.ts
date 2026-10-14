import { expect, test } from "bun:test"
import type { AnyEvent, UiApi, UiRequestOptions } from "@amira/api"
import { EventBus } from "../src/event-bus.ts"
import { UiRequests } from "../src/ui-requests.ts"

function setup(sessionId = "host") {
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  const ui = new UiRequests(bus, { sessionId })
  return { bus, events, ui }
}

test("extension questions associate pending requests and lifecycle events with a conversation", async () => {
  const { bus, events, ui } = setup()
  const answer = ui
    .api("extension")
    .ask([{ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }], {
      sessionId: "owned-conversation",
    })
  const request = ui.pending[0]!
  expect(request).toMatchObject({ kind: "ask", sessionId: "owned-conversation", source: "extension" })
  expect(ui.respond(request.requestId, [{ selected: ["Yes"] }])).toBeUndefined()
  expect(await answer).toEqual([{ selected: ["Yes"] }])
  await bus.flush()
  expect(events).toMatchObject([
    { type: "ui.request", sessionId: "owned-conversation", data: { requestId: request.requestId } },
    {
      type: "ui.resolved",
      sessionId: "owned-conversation",
      data: { requestId: request.requestId, cancelled: false },
    },
  ])
})

test("fallback form dialogs retain the requested display conversation", async () => {
  const { bus, events, ui } = setup()
  ui.formMode = "dialogs"
  bus.subscribe((event) => {
    if (event.type !== "ui.request") return
    const request = event.data
    if (request.kind === "input") ui.respond(request.requestId, "Ada")
    else if (request.kind === "select") ui.respond(request.requestId, request.options[0]!)
  })
  const answer = ui
    .api("extension")
    .form(
      { title: "Profile", fields: [{ type: "text", id: "name", label: "Name" }] },
      { sessionId: "owned-conversation" },
    )
  expect(await answer).toEqual({ name: "Ada" })
  await bus.flush()
  const requests = events.filter((event) => event.type === "ui.request")
  expect(requests.length).toBeGreaterThan(1)
  for (const request of requests) {
    expect(request.sessionId).toBe("owned-conversation")
    expect(request.data).toMatchObject({ sessionId: "owned-conversation", source: "extension" })
  }
  expect(events.every((event) => event.sessionId === "owned-conversation")).toBe(true)
})

const dialogs: {
  name: string
  open(api: UiApi, opts: UiRequestOptions): Promise<unknown>
}[] = [
  { name: "select", open: (api, opts) => api.select("Pick", ["Yes", "No"], opts) },
  { name: "choose", open: (api, opts) => api.choose("Pick", ["Yes"], { ...opts, sections: [] }) },
  { name: "confirm", open: (api, opts) => api.confirm("Continue?", undefined, opts) },
  { name: "input", open: (api, opts) => api.input("Name", opts) },
  { name: "reviewDiff", open: (api, opts) => api.reviewDiff("Review", "", ["Accept"], opts) },
  { name: "form", open: (api, opts) => api.form({ title: "Profile", fields: [] }, opts) },
  { name: "extensionSettings", open: (api, opts) => api.extensionSettings("extension", opts) },
]

test.each(dialogs)("$name preserves display association when aborted", async ({ open }) => {
  const { bus, events, ui } = setup()
  ui.setExtensionSettingsAccessor(() => ({
    fields: [],
    get: () => ({}),
    defaultScope: "user",
    save: () => {},
  }))
  const controller = new AbortController()
  const answer = open(ui.api("extension"), { sessionId: "owned-conversation", signal: controller.signal })
  const request = ui.pending[0]!
  expect(request.sessionId).toBe("owned-conversation")
  controller.abort()
  expect(await answer).toBeUndefined()
  await bus.flush()
  expect(events).toMatchObject([
    { type: "ui.request", sessionId: "owned-conversation", data: { requestId: request.requestId } },
    {
      type: "ui.resolved",
      sessionId: "owned-conversation",
      data: { requestId: request.requestId, cancelled: true },
    },
  ])
})

test.each(["host", "configured-session"])(
  "unassociated dialogs keep the %s service session",
  async (sessionId) => {
    const { bus, events, ui } = setup(sessionId)
    const answer = ui.api().confirm("Approve?")
    const request = ui.pending[0]!
    expect(request.sessionId).toBe(sessionId)
    ui.respond(request.requestId, true)
    expect(await answer).toBe(true)
    await bus.flush()
    expect(events.map((event) => event.sessionId)).toEqual([sessionId, sessionId])
  },
)

test("live choices keep their request identity and conversation through presentation updates", async () => {
  const { bus, events, ui } = setup()
  let label = "Before"
  const opts = { sessionId: "owned-conversation", sections: [], live: () => ({ optionLabels: [label] }) }
  const answer = ui.api("extension").choose("Pick", ["option"], opts)
  const requestId = ui.pending[0]!.requestId
  opts.sessionId = "changed-after-open"
  await bus.flush()
  label = "After"
  bus.emit("session.title", { title: "Updated" }, { sessionId: "host" })
  await bus.flush()
  const requests = events.filter((event) => event.type === "ui.request")
  expect(requests).toHaveLength(2)
  for (const request of requests) {
    expect(request.sessionId).toBe("owned-conversation")
    expect(request.data).toMatchObject({ requestId, sessionId: "owned-conversation" })
  }
  expect(ui.pending[0]).toMatchObject({ requestId, sessionId: "owned-conversation", optionLabels: ["After"] })
  ui.respond(requestId, "option")
  expect(await answer).toEqual({ option: "option" })
  await bus.flush()
  expect(events.at(-1)).toMatchObject({ type: "ui.resolved", sessionId: "owned-conversation" })
})

test("form action progress retains the session captured when the request opened", async () => {
  const { bus, events, ui } = setup("service-session")
  const opts = { sessionId: "owned-conversation" }
  const answer = ui.api("extension").form(
    {
      title: "Connection",
      fields: [
        {
          type: "action",
          id: "probe",
          label: "Probe",
          run: async ({ progress }) => {
            progress("Connecting")
            return { message: "Connected" }
          },
        },
      ],
    },
    opts,
  )
  const requestId = ui.pending[0]!.requestId
  opts.sessionId = "changed-after-open"
  expect(await ui.runFormAction(requestId, "probe", {})).toEqual({ message: "Connected" })
  expect(ui.respond(requestId, {})).toBeUndefined()
  expect(await answer).toEqual({})
  await bus.flush()
  expect(events).toMatchObject([
    { type: "ui.request", sessionId: "owned-conversation", data: { requestId } },
    {
      type: "ui.progress",
      sessionId: "owned-conversation",
      data: { requestId, action: "probe", text: "Connecting" },
    },
    { type: "ui.resolved", sessionId: "owned-conversation", data: { requestId, cancelled: false } },
  ])
})

test("settings-save errors and retry resolution retain the request's captured session", async () => {
  const { bus, events, ui } = setup("service-session")
  let fail = true
  ui.setExtensionSettingsAccessor(() => ({
    fields: [],
    get: () => ({}),
    defaultScope: "user",
    save: async () => {
      if (fail) throw new Error("Could not save settings")
    },
  }))
  const opts = { sessionId: "owned-conversation" }
  const answer = ui.api("extension").extensionSettings("extension", opts)
  const requestId = ui.pending[0]!.requestId
  opts.sessionId = "changed-after-open"
  expect(ui.respond(requestId, { values: {}, scope: "user" })).toBeUndefined()
  await Bun.sleep(0)
  await bus.flush()
  expect(ui.pending).toHaveLength(1)
  expect(events).toMatchObject([
    { type: "ui.request", sessionId: "owned-conversation", data: { requestId } },
    {
      type: "ui.progress",
      sessionId: "owned-conversation",
      data: { requestId, action: "save", text: "Could not save settings" },
    },
  ])
  fail = false
  expect(ui.respond(requestId, { values: {}, scope: "user" })).toBeUndefined()
  expect(await answer).toEqual({ values: {}, scope: "user" })
  await bus.flush()
  expect(events.at(-1)).toMatchObject({
    type: "ui.resolved",
    sessionId: "owned-conversation",
    data: { requestId, cancelled: false },
  })
})

test("display association does not replace the extension's cancellation identity", async () => {
  const { bus, events, ui } = setup()
  const first = ui.api("first-extension").input("First", { sessionId: "same-conversation" })
  const firstId = ui.pending[0]!.requestId
  const second = ui.api("second-extension").input("Second", { sessionId: "same-conversation" })
  const secondId = ui.pending[1]!.requestId
  expect(firstId).not.toBe(secondId)
  ui.cancelAll("same-conversation")
  expect(ui.pending).toHaveLength(2)
  ui.cancelAll("first-extension")
  expect(await first).toBeUndefined()
  expect(ui.pending.map((request) => request.requestId)).toEqual([secondId])
  ui.respond(secondId, "Done")
  expect(await second).toBe("Done")
  await bus.flush()
  expect(events.every((event) => event.sessionId === "same-conversation")).toBe(true)
})
