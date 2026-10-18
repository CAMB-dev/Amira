import "../server/offline.ts"
import { expect, test } from "bun:test"
import { encodeRemoteMessage, RemoteDecoder } from "../../src/remote/codec.ts"
import { validateRemoteDto, validateRemoteFrame, validateRemoteParams } from "../../src/remote-schema.ts"
import type { ServerUiRequest } from "../../src/server/runtime.ts"

const requests = {
  select: {
    kind: "select",
    requestId: "q1",
    title: "Agents",
    options: ["agent", "worktree"],
    optionLabels: ["Agent", "Worktree"],
    initial: "agent",
    descriptions: ["Finished", "Kept"],
    searchTexts: ["history", "changes"],
    optionStatuses: ["done", null],
    sections: [{ at: 0, title: "Agents", choose: "Select", keys: [{ key: "d", label: "Delete" }] }],
  },
  confirm: {
    kind: "confirm",
    requestId: "q1",
    title: "Approve?",
    message: "Read the fixture",
    always: "Read tools",
    other: true,
    preview: [{ kind: "text", text: "Preview", lineNo: 1, marker: "unchecked", wrap: true }],
  },
  input: {
    kind: "input",
    requestId: "q1",
    title: "Input",
    placeholder: "Example",
    initial: "value",
    secret: true,
  },
  "diff-review": {
    kind: "diff-review",
    requestId: "q1",
    title: "Review",
    diff: "+change",
    options: ["accept", "decline"],
  },
  ask: {
    kind: "ask",
    requestId: "q1",
    title: "Question",
    questions: [
      {
        question: "Choose",
        header: "Choice",
        options: [{ label: "A", description: "First" }],
        multiSelect: true,
      },
    ],
  },
  form: {
    kind: "form",
    requestId: "q1",
    title: "Form",
    fields: [{ type: "checkbox", id: "enabled", label: "Enabled", default: false }],
  },
  "extension-settings": {
    kind: "extension-settings",
    requestId: "q1",
    name: "fixture",
    title: "Settings",
    scope: "user",
    fields: [
      { type: "number", key: "count", label: "Count", default: 1, min: 0, max: 10, step: 1 },
      { type: "toggle", key: "enabled", label: "Enabled", default: true },
      {
        type: "choice",
        key: "choice",
        label: "Choice",
        default: "a",
        options: ["a", { value: "b", label: "B", description: "Second" }],
      },
      {
        type: "text",
        key: "name",
        label: "Name",
        default: "fixture",
        placeholder: "Example",
        pattern: ".+",
        maxLength: 20,
      },
      { type: "colour", key: "colour", label: "Colour", default: "#ffffff" },
    ],
    values: { count: 1, enabled: true, choice: "a", name: "fixture", colour: "#ffffff" },
    sources: { count: "flags" },
  },
} satisfies { [K in ServerUiRequest["kind"]]: Extract<ServerUiRequest, { kind: K }> }

for (const [kind, request] of Object.entries(requests)) {
  test(`UI request ${kind} has a closed, roundtrippable presentation DTO`, () => {
    const dto = { ...request, source: "fixture", sourceLabel: "Fixture", sessionId: "s1" }
    validateRemoteDto("uiRequest", dto)
    const message = validateRemoteFrame({
      v: 1,
      kind: "event",
      daemonEpoch: "epoch-1",
      seq: 1,
      payload: { seq: 1, ts: 1, sessionId: "s1", type: "ui.request", data: dto },
    })
    if (message.kind === "chunk") throw new Error("Expected a complete event")
    const decoder = new RemoteDecoder()
    expect([...encodeRemoteMessage(message)].flatMap((bytes) => decoder.push(bytes))).toEqual([message])
    decoder.finish()
    for (const invalid of [
      { ...dto, unexpected: true },
      { ...dto, title: false },
      { ...dto, kind: "unknown" },
    ])
      expect(() => validateRemoteDto("uiRequest", invalid)).toThrow()
  })
}

test("UI response variants remain typed and reject malformed nested answers", () => {
  for (const value of [
    null,
    true,
    false,
    "always",
    { other: "Instead" },
    { option: "chosen", key: "d" },
    [{ selected: ["a"], other: "Custom" }],
    { values: { name: "a", enabled: true, count: 1 }, scope: "project" },
  ])
    validateRemoteParams("ui.respond", { requestId: "q1", value })
  for (const value of [
    1,
    {},
    { other: false },
    { option: "a", extra: true },
    [{ selected: "a" }],
    [{ selected: ["a"], extra: true }],
    { values: { enabled: [] }, scope: "project" },
    { values: {}, scope: "flags" },
  ])
    expect(() => validateRemoteParams("ui.respond", { requestId: "q1", value })).toThrow()
})
