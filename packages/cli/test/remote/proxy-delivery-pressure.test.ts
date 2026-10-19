import "../server/offline.ts"
import { expect, test } from "bun:test"
import type { StreamEvent } from "@amira/ai"
import { REMOTE_LIMITS } from "../../src/remote/protocol.ts"
import { collectEvents, deferred } from "./model-proxy-fixture.ts"
import { bounded, tick, transportFixture } from "./model-transport-fixture.ts"

const done: StreamEvent = {
  type: "done",
  message: { role: "assistant", model: { provider: "p", model: "m" }, content: [], stopReason: "end" },
}

for (const resume of [false, true]) {
  test(`writer queue rejection ${resume ? "resumes the same call" : "terminates within the reconnect bound"}`, async () => {
    const started = deferred()
    const release = deferred()
    const blocked = deferred()
    const unblock = deferred()
    let executions = 0
    const fixture = transportFixture(
      async function* () {
        executions++
        started.resolve()
        await release.promise
        yield { type: "text.delta", text: "retained output".repeat(30) }
        yield done
      },
      resume ? 1000 : 50,
    )
    try {
      const { local, server } = await fixture.connectTransport({
        async localWrite(bytes) {
          const frame = JSON.parse(Buffer.from(bytes).toString())
          if (frame.kind === "ping" && frame.id === "pressure-0") {
            blocked.resolve()
            await unblock.promise
          }
        },
      })
      const work = collectEvents(fixture.proxy.stream(fixture.request))
      await started.promise
      await tick() // Allow model.open admission to finish before applying pressure.
      const queued = Array.from({ length: REMOTE_LIMITS.queuedFrames }, (_, index) =>
        local.send({ v: 1, kind: "ping", id: `pressure-${index}` }).catch(() => {}),
      )
      await blocked.promise
      await expect(local.send({ v: 1, kind: "ping", id: "overflow" })).rejects.toMatchObject({
        code: "limit_exceeded",
      })
      // A real healthy writer rejects queue admission without closing its connection.
      let closed = false
      void local.closed.then(() => {
        closed = true
      })
      await tick()
      expect(closed).toBe(false)
      release.resolve()
      expect(await bounded(server.closed.then(() => "closed"))).toBe("closed")
      unblock.resolve()
      await Promise.all(queued)
      if (resume) await fixture.connectTransport()
      const events = await bounded(work)
      expect(events).not.toBe("pending")
      if (events !== "pending") {
        if (resume) {
          expect(
            events
              .filter((event) => event.type === "text.delta")
              .map((event) => event.text)
              .join(""),
          ).toBe("retained output".repeat(30))
          expect(events.at(-1)?.type).toBe("done")
        } else {
          expect(events.at(-1)).toMatchObject({
            type: "error",
            error: { code: "proxy_reconnect_expired" },
            retryable: false,
          })
        }
      }
      expect(executions).toBe(1)
    } finally {
      release.resolve()
      unblock.resolve()
      fixture.close()
    }
  })
}
