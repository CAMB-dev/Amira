import { expect, spyOn, test } from "bun:test"
import type { UiApi } from "@amira/api"
import { FormView, operationFormBackend } from "@amira/tui"
import { key, textKey } from "@amira/tui-kit"
import { createRemoteFormBackend } from "../../src/remote/agent-port-forms.ts"
import { agentPortFixture, until } from "./agent-port-fixture.ts"

for (const boundary of ["before", "after"] as const) {
  for (const intent of ["submit", "cancel"] as const) {
    test(`form admission lost ${boundary} acceptance recovers the retained draft and ${intent} intent`, async () => {
      let ui!: UiApi
      let disconnect = () => {}
      let dropped = false
      const claims: { editor: string; revision: number }[] = []
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
            if (frame.kind !== "response" || frame.op !== "form.open" || !frame.ok) return
            claims.push(frame.result)
            if (boundary === "after" && !dropped) {
              dropped = true
              disconnect()
              throw new Error("Lost form.open response after host acceptance")
            }
          },
        },
      )
      disconnect = f.disconnect
      const requests = spyOn(f.port, "request")
      let view: FormView | undefined
      let renders = 0
      try {
        const answer = ui.form({
          title: "Admission recovery",
          fields: [{ type: "text", id: "name", label: "Name" }],
        })
        await until(() => f.port.pendingRequests.length === 1)
        const request = f.port.pendingRequests[0]!
        if (request.kind !== "form") throw new Error("Expected form")
        view = new FormView(operationFormBackend(createRemoteFormBackend(f.port, request)), {
          requestRender() {
            renders++
          },
          onClose() {},
        })
        view.handleInput(textKey("draft"))
        // The request is queued behind connection.ready, so closing in this stack loses it
        // before admission. The other case drops the real encoded, accepted response.
        if (boundary === "before") f.disconnect()
        await until(() => f.port.status === "disconnected")
        expect(claims).toHaveLength(boundary === "before" ? 0 : 1)
        expect(view.form.values).toEqual({ name: "draft" })
        expect(view.closed).toBe(false)
        if (intent === "cancel") {
          view.handleInput(key("escape"))
          expect(view.form.confirmingCancel).toBe(true)
          view.handleInput(textKey("y"))
          expect(view.closed).toBe(false)
        }
        const beforeRecovery = renders
        await f.port.reconnect()
        if (intent === "submit") {
          await until(() => requests.mock.calls.some(([operation]) => operation === "form.evaluate"))
          // The view requests its next frame after accepting the host evaluation.
          await until(() => renders > beforeRecovery)
          expect(claims).toHaveLength(boundary === "before" ? 1 : 2)
          expect(view.form.values).toEqual({ name: "draft" })
          view.handleInput(key("s", { ctrl: true }))
        }
        await until(() => view!.closed)
        expect(await answer).toEqual(intent === "submit" ? { name: "draft" } : undefined)
        const opens = requests.mock.calls.filter(([operation]) => operation === "form.open")
        expect(opens).toHaveLength(2)
        expect(opens[0]![2]?.operationId).toBeString()
        expect(opens[1]![2]?.operationId).toBe(opens[0]![2]?.operationId)
        expect(claims.every((claim) => claim.revision === 0)).toBe(true)
        if (boundary === "after") expect(claims[1]).toEqual(claims[0])
      } finally {
        view?.close(true)
        requests.mockRestore()
        await f.close()
      }
    })
  }
}

test("a fresh form mounted from a snapshot while reconnecting waits for editor admission", async () => {
  let ui!: UiApi
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
  let view: FormView | undefined
  try {
    const answer = ui.form({
      title: "Snapshot admission",
      fields: [{ type: "text", id: "name", label: "Name" }],
    })
    await until(() => f.port.pendingRequests.length === 1)
    f.disconnect()
    await until(() => f.port.status === "disconnected")
    const connected = f.port.reconnect()
    expect(f.port.status).toBe("reconnecting")
    const request = f.port.pendingRequests[0]!
    if (request.kind !== "form") throw new Error("Expected form")
    view = new FormView(operationFormBackend(createRemoteFormBackend(f.port, request)), {
      requestRender() {},
      onClose() {},
      replay: true,
    })
    view.handleInput(key("escape"))
    await connected
    await until(() => view!.closed)
    expect(await answer).toBeUndefined()
  } finally {
    view?.close(true)
    await f.close()
  }
})
