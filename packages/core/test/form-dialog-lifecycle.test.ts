import { expect, test } from "bun:test"
import type { FormActionContext, FormSpec } from "@amira/api"
import { EventBus } from "../src/event-bus.ts"
import { UiRequests } from "../src/ui-requests.ts"

test.each(["action", "save"] as const)(
  "dialog form cancellation owns the whole %s callback lifetime",
  async (phase) => {
    for (const source of [undefined, "owner"]) {
      const ui = new UiRequests(new EventBus())
      ui.formMode = "dialogs"
      const started = Promise.withResolvers<AbortSignal>()
      const release = Promise.withResolvers<void>()
      const callback = async ({ signal }: FormActionContext) => {
        started.resolve(signal)
        await release.promise
        return { message: "late success", tone: "success" as const }
      }
      const spec: FormSpec = {
        title: "Cancellable dialog form",
        fields: phase === "action" ? [{ id: "probe", label: "Probe", type: "action", run: callback }] : [],
        preview: () => ["masked preview"],
        ...(phase === "save" ? { beforeSubmit: callback } : {}),
      }
      let finished = false
      const answer = ui.form(spec, { source: "owner" }).then((values) => {
        finished = true
        return values
      })
      ui.respond(ui.pending[0]!.requestId, phase === "action" ? "Yes" : "Save")
      const signal = await started.promise
      ui.cancelAll(source)
      const wasAborted = signal.aborted
      await Bun.sleep(0)
      const finishedBeforeRelease = finished
      release.resolve()
      await Bun.sleep(0)
      for (const request of ui.pending) ui.respond(request.requestId, "Save")
      const result = await answer
      expect(wasAborted).toBe(true)
      expect(finishedBeforeRelease).toBe(true)
      expect(result).toBeUndefined()
      expect(ui.pending).toEqual([])
    }
  },
)
