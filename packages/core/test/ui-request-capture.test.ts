import { expect, test } from "bun:test"
import { EventBus } from "../src/event-bus.ts"
import { onUiRequestCreated } from "../src/ui-request-capture.ts"
import { UiRequests } from "../src/ui-requests.ts"

test("local ownership capture precedes queued request delivery and is released by unsubscribe", async () => {
  const bus = new EventBus()
  const ui = new UiRequests(bus)
  const captured: string[] = []
  const delivered: string[] = []
  const offBus = bus.subscribe((event) => {
    if (event.type === "ui.request") delivered.push(event.data.requestId)
  })
  const offCapture = onUiRequestCreated(ui, (request) => {
    expect(ui.requestState(request.requestId)).toBe("pending")
    captured.push(request.requestId)
  })
  try {
    const first = ui.api("approval").confirm("Allow first?")
    const firstId = ui.pending[0]!.requestId
    expect(captured).toEqual([firstId])
    expect(delivered).toEqual([])
    await bus.flush()
    expect(delivered).toEqual([firstId])
    ui.cancel(firstId)
    await first
    offCapture()
    const second = ui.api("approval").confirm("Allow second?")
    expect(captured).toEqual([firstId])
    ui.cancelAll()
    await second
  } finally {
    offCapture()
    offBus()
    ui.cancelAll()
  }
})

test("a failing frontend capture cannot prevent host request publication or other captures", async () => {
  const bus = new EventBus()
  const ui = new UiRequests(bus)
  const observed: string[] = []
  const offBad = onUiRequestCreated(ui, () => {
    throw new Error("frontend failed")
  })
  const offGood = onUiRequestCreated(ui, (request) => {
    observed.push(request.requestId)
  })
  try {
    const answer = ui.api("approval").confirm("Allow?")
    const id = ui.pending[0]!.requestId
    expect(observed).toEqual([id])
    expect(ui.respondAcknowledged(id, true)).toEqual({ status: "accepted" })
    expect(await answer).toBe(true)
  } finally {
    offBad()
    offGood()
    ui.cancelAll()
  }
})
