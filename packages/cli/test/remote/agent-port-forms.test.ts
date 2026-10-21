import { expect, test } from "bun:test"
import type { UiApi } from "@amira/api"
import { createRemoteFormBackend } from "../../src/remote/agent-port-forms.ts"
import { agentPortFixture, until } from "./agent-port-fixture.ts"

test("remote form adapter executes host validation/actions and preserves dialog/editor authority over reconnect", async () => {
  let ui!: UiApi
  let actions = 0
  const f = await agentPortFixture({
    builtins: async () => [
      {
        source: "fixture",
        extension(api) {
          ui = api.ui
        },
      },
    ],
  })
  try {
    const answer = ui.form({
      title: "Remote form",
      fields: [
        { type: "text", id: "name", label: "Name", required: true },
        {
          type: "action",
          id: "load",
          label: "Load",
          async run() {
            actions++
            return { values: { name: "remote" } }
          },
        },
      ],
    })
    await until(() => f.port.pendingRequests.length === 1)
    const request = f.port.pendingRequests[0]!
    if (request.kind !== "form") throw new Error("Expected form")
    const form = createRemoteFormBackend(f.port, request)
    const editor = await form.openEditor!()
    const evaluation = await form.evaluate({ ...editor, values: {} })
    expect(evaluation.errors).toHaveProperty("name")
    expect(await form.runAction({ ...editor, values: {}, action: "load" })).toMatchObject({
      status: "accepted",
      result: { values: { name: "remote" } },
    })
    expect(actions).toBe(1)
    f.disconnect()
    await until(() => f.port.status === "disconnected")
    await f.port.reconnect()
    expect(f.port.pendingRequests[0]!.requestId).toBe(request.requestId)
    expect(await form.submit({ ...editor, values: { name: "remote" } })).toMatchObject({ status: "accepted" })
    expect(await answer).toEqual({ name: "remote" })
    await until(() => f.port.pendingRequests.length === 0)
  } finally {
    await f.close()
  }
})
