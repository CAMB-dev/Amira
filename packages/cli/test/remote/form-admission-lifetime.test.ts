import { expect, spyOn, test } from "bun:test"
import type { UiApi } from "@amira/api"
import { createRemoteFormBackend } from "../../src/remote/agent-port-forms.ts"
import { agentPortFixture, until } from "./agent-port-fixture.ts"

for (const ending of ["abort", "detach"] as const) {
  test(`waiting form admission stops on ${ending} without admitting an editor`, async () => {
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
    const requests = spyOn(f.port, "request")
    try {
      void ui.form({ title: "Admission lifetime", fields: [] })
      await until(() => f.port.pendingRequests.length === 1)
      const request = f.port.pendingRequests[0]!
      if (request.kind !== "form") throw new Error("Expected form")
      f.disconnect()
      await until(() => f.port.status === "disconnected")
      const form = createRemoteFormBackend(f.port, request)
      const controller = new AbortController()
      const pending = Promise.resolve(form.openEditor!({ signal: controller.signal })).catch(
        (error: unknown) => error,
      )
      if (ending === "abort") controller.abort()
      else await f.port.detach()
      expect(await pending).toMatchObject({ code: ending === "abort" ? "cancelled" : "disconnected" })
      expect(requests.mock.calls.filter(([operation]) => operation === "form.open")).toHaveLength(0)
      if (ending === "abort") {
        await f.port.reconnect()
        const editor = await form.openEditor!()
        expect(editor.revision).toBe(0)
        expect(requests.mock.calls.filter(([operation]) => operation === "form.open")).toHaveLength(1)
      }
    } finally {
      requests.mockRestore()
      await f.close()
    }
  })
}
