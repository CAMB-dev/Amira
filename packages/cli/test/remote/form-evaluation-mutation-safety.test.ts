import { expect, spyOn, test } from "bun:test"
import type { UiApi } from "@amira/api"
import { FormView, operationFormBackend } from "@amira/tui"
import { key } from "@amira/tui-kit"
import { createRemoteFormBackend } from "../../src/remote/agent-port-forms.ts"
import { agentPortFixture, until } from "./agent-port-fixture.ts"

test("recovering evaluation after a lost automatic action reply never reissues the action", async () => {
  let ui!: UiApi
  let disconnect = () => {}
  let actions = 0
  let evaluations = 0
  const f = await agentPortFixture(
    {
      builtins: async () => [
        {
          source: "fixture",
          extension(api) {
            ui = api.ui
          },
        },
      ],
    },
    {},
    {
      async serverWrite(bytes) {
        const frame = JSON.parse(new TextDecoder().decode(bytes))
        if (frame.kind !== "response" || !frame.ok) return
        if (frame.op === "form.evaluate") evaluations++
        if (frame.op === "form.action") {
          disconnect()
          throw new Error("Lost paid action reply after acceptance")
        }
      },
    },
  )
  disconnect = f.disconnect
  const requests = spyOn(f.port, "request")
  let view: FormView | undefined
  try {
    const answer = ui.form({
      title: "Mutation safety",
      fields: [
        { type: "text", id: "name", label: "Name", default: "paid" },
        {
          type: "action",
          id: "paid",
          label: "Paid lookup",
          auto: { watch: ["name"], ready: () => true },
          async run() {
            actions++
            return {}
          },
        },
      ],
    })
    await until(() => f.port.pendingRequests.length === 1)
    const request = f.port.pendingRequests[0]!
    if (request.kind !== "form") throw new Error("Expected form")
    view = new FormView(operationFormBackend(createRemoteFormBackend(f.port, request)), {
      requestRender() {},
      onClose() {},
    })
    await until(() => f.port.status === "disconnected")
    expect(actions).toBe(1)
    await f.port.reconnect()
    await until(() => evaluations === 2)
    await Bun.sleep(0) // Deliver the recovered encoded evaluation to the mounted view.
    expect(view.closed).toBe(false)
    expect(view.form.values).toEqual({ name: "paid" })
    expect(actions).toBe(1)
    expect(requests.mock.calls.filter(([op]) => op === "form.action")).toHaveLength(1)
    expect(requests.mock.calls.filter(([op]) => op === "form.submit")).toHaveLength(0)
    expect(requests.mock.calls.filter(([op]) => op === "form.open")).toHaveLength(1)
    view.handleInput(key("escape"))
    await until(() => view!.closed)
    expect(await answer).toBeUndefined()
  } finally {
    view?.close(true)
    requests.mockRestore()
    await f.close()
  }
})
