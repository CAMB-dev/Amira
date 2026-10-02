import { expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { TraceRecord } from "@amira/api"
import { EventBus } from "../src/event-bus.ts"
import { TraceRecorder } from "../src/trace.ts"
import { TraceFile } from "../src/trace-file.ts"
import { readTrace } from "../src/trace-reader.ts"

test("recorder close drains records delivered while an earlier file handle is closing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-trace-close-"))
  const file = path.join(dir, "root.jsonl")
  writeFileSync(file, "{}\n")
  const bus = new EventBus()
  const recorder = new TraceRecorder(bus)
  const closing = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const originalOpen = fs.open
  let held = false
  const open = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args)
    if (!held) {
      held = true
      const close = handle.close.bind(handle)
      spyOn(handle, "close").mockImplementation(async () => {
        closing.resolve()
        await release.promise
        return close()
      })
    }
    return handle
  })
  try {
    recorder.register("root", file)
    bus.emit(
      "session.start",
      { reason: "startup", cwd: dir, model: { provider: "mock", model: "test" } },
      { sessionId: "root" },
    )
    // The header is written with the first record, not alone.
    bus.emit("status.changed", { status: "working" }, { sessionId: "root" })
    await bus.flush()
    const flushing = recorder.flush()
    await closing.promise
    bus.emit("status.changed", { status: "idle" }, { sessionId: "root" })
    await bus.flush()
    const closed = recorder.close()
    release.resolve()
    await Promise.all([flushing, closed])
    expect((await readTrace(file)).map((record) => record.type)).toEqual(["trace", "status", "status"])
  } finally {
    release.resolve()
    open.mockRestore()
    await recorder.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const emergency of [false, true]) {
  test(`${emergency ? "emergency" : "async"} append isolates a torn tail before a resumed header`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "amira-trace-tail-"))
    const file = path.join(dir, "root.jsonl")
    writeFileSync(file, "{}\n")
    writeFileSync(`${file}.trace.jsonl`, '{"type":"trace","v":2,"sessionId":"root","startedAt":0}\n{"type":')
    const records: TraceRecord[] = [
      { type: "trace", v: 1, sessionId: "root", startedAt: 10 },
      { type: "status", at: 20, status: "idle" },
    ]
    const errors: unknown[] = []
    const writer = new TraceFile(file, (error) => errors.push(error))
    try {
      for (const record of records) writer.push(record)
      if (emergency) writer.emergencyFlush()
      else await writer.flush()
      expect(errors).toEqual([])
      expect(await readTrace(file)).toEqual(records)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
