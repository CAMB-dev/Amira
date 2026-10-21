import { expect, spyOn, test } from "bun:test"
import type { UiApi } from "@amira/api"
import { FormView, operationFormBackend } from "@amira/tui"
import { key, textKey } from "@amira/tui-kit"
import { plain } from "../../../tui-kit/test/context.ts"
import { createRemoteFormBackend } from "../../src/remote/agent-port-forms.ts"
import { agentPortFixture, until } from "./agent-port-fixture.ts"

for (const scenario of [
  "lost evaluation",
  "truncated evaluation",
  "superseded evaluation",
  "offline save",
  "offline cancel",
] as const) {
  test(`${scenario} recovers the mounted editor without replaying mutations`, async () => {
    let ui!: UiApi
    let disconnect = () => {}
    let dropEvaluation = false
    let dropped = false
    let checks = 0
    let changes = 0
    const evaluations: number[] = []
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
        async serverWrite(bytes, io) {
          const frame = JSON.parse(new TextDecoder().decode(bytes))
          if (frame.kind !== "response" || !frame.ok) return
          if (frame.op === "form.open") claims.push(frame.result)
          if (frame.op !== "form.evaluate") return
          evaluations.push(frame.result.revision)
          if (dropEvaluation && !dropped) {
            dropped = true
            if (scenario === "truncated evaluation") {
              await io.write(bytes.subarray(0, 17))
              io.close()
              return false
            }
            disconnect()
            throw new Error("Lost accepted form.evaluate response")
          }
        },
      },
    )
    disconnect = f.disconnect
    const requests = spyOn(f.port, "request")
    let view: FormView | undefined
    try {
      const answer = ui.form({
        title: "Draft recovery",
        fields: [{ type: "text", id: "name", label: "Name" }],
        change: () => {
          changes++
          return {}
        },
        preview: (values) => [`Evaluated: ${values.name || "empty"}`],
        beforeSubmit: async () => {
          checks++
          return {}
        },
      })
      await until(() => f.port.pendingRequests.length === 1)
      const request = f.port.pendingRequests[0]!
      if (request.kind !== "form") throw new Error("Expected form")
      const session = f.port.identity
      view = new FormView(operationFormBackend(createRemoteFormBackend(f.port, request)), {
        requestRender() {},
        onClose() {},
      })
      const screen = () => view!.render(80, plain).join("\n")
      await until(() => screen().includes("Evaluated: empty"))
      const lost =
        scenario === "lost evaluation" ||
        scenario === "truncated evaluation" ||
        scenario === "superseded evaluation"
      if (lost) {
        dropEvaluation = true
        view.handleInput(textKey("draft"))
      } else f.disconnect()
      await until(() => f.port.status === "disconnected")
      if (!lost) view.handleInput(textKey("draft"))
      if (scenario === "superseded evaluation") view.handleInput(textKey("-new"))
      const name = scenario === "superseded evaluation" ? "draft-new" : "draft"
      // No offline editor revision has reached the real host authority.
      expect(evaluations).toEqual(lost ? [0, 1] : [0])
      expect(view.form.values).toEqual({ name })
      if (scenario === "offline cancel") {
        view.handleInput(key("escape"))
        view.handleInput(textKey("y"))
      } else view.handleInput(key("s", { ctrl: true }))
      expect(view.closed).toBe(false)
      await f.port.reconnect()
      expect(f.port.identity).toEqual(session)
      if (scenario === "offline cancel") {
        await until(() => view!.closed)
        expect(await answer).toBeUndefined()
        expect(evaluations).toEqual([0])
      } else {
        await until(() => screen().includes(`Evaluated: ${name}`))
        expect(view.form.values).toEqual({ name })
        expect(view.closed).toBe(false)
        expect(checks).toBe(0)
        expect(requests.mock.calls.filter(([op]) => op === "form.submit")).toHaveLength(0)
        view.handleInput(key("s", { ctrl: true }))
        await until(() => view!.closed)
        expect(await answer).toEqual({ name })
        expect(checks).toBe(1)
        expect(changes).toBe(scenario === "superseded evaluation" ? 2 : 1)
        expect(evaluations).toEqual(
          scenario === "superseded evaluation" ? [0, 1, 2] : lost ? [0, 1, 1] : [0, 1],
        )
      }
      expect(claims).toHaveLength(1)
      const drafts = requests.mock.calls
        .filter(([op]) => op === "form.evaluate" || op === "form.submit")
        .map(([, params]) => (params as { draft: { editor: string; revision: number } }).draft)
      expect(drafts.every((draft) => draft.editor === claims[0]!.editor)).toBe(true)
      expect(drafts.at(-1)?.revision).toBe(
        scenario === "superseded evaluation" ? 2 : scenario === "offline cancel" ? 0 : 1,
      )
      expect(requests.mock.calls.filter(([op]) => op === "form.open")).toHaveLength(1)
      expect(requests.mock.calls.filter(([op]) => op === "form.action")).toHaveLength(0)
    } finally {
      view?.close(true)
      requests.mockRestore()
      await f.close()
    }
  })
}
