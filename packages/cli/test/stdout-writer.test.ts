import { afterEach, expect, spyOn, test } from "bun:test"
import { consoleCodePage } from "@amira/tui-kit/console-code-page"
import { type FromStdoutWorker, stdoutWriter, type ToStdoutWorker } from "../src/stdout-writer.ts"

const originalWorker = globalThis.Worker
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  globalThis.Worker = originalWorker
})

class FakeWorker {
  onmessage?: (event: { data: FromStdoutWorker }) => void
  listeners = new Map<string, () => void>()
  acknowledge = true
  constructor(private write: (text: string) => void) {}
  postMessage(message: ToStdoutWorker) {
    this.write(message.text)
    if (this.acknowledge) this.onmessage?.({ data: { type: "written", seq: message.seq } })
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, fn)
  }
  terminate() {}
}

function setup(fallback = false) {
  const events: string[] = []
  const guard = spyOn(consoleCodePage, "ensure").mockImplementation(() => {
    events.push("guard")
  })
  cleanups.push(() => guard.mockRestore())
  const worker = new FakeWorker((text) => events.push(text))
  globalThis.Worker = new Proxy(FakeWorker, {
    construct() {
      if (fallback) throw new Error("worker unavailable")
      return worker
    },
  }) as unknown as typeof Worker
  const writer = stdoutWriter()
  cleanups.push(() => writer.close())
  return { events, worker, writer }
}

test("asserts code pages before posting each stdout worker batch", async () => {
  const { events, writer } = setup()
  await writer.write("❯ ● ✓ └ 中文\n")
  await writer.write("second frame")
  await writer.flush()
  expect(events).toEqual(["guard", "❯ ● ✓ └ 中文\n", "guard", "second frame"])
})

test("asserts code pages for the direct stdout fallback", async () => {
  const { events, writer } = setup(true)
  const write = spyOn(process.stdout, "write").mockImplementation((text) => {
    events.push(String(text))
    return true
  })
  cleanups.push(() => write.mockRestore())
  await writer.write("❯ ● ✓ └ 中文\n")
  expect(events).toEqual(["guard", "❯ ● ✓ └ 中文\n"])
})

test("checks again when buffered worker batches are replayed through the fallback", async () => {
  const { events, worker, writer } = setup()
  worker.acknowledge = false
  await writer.write("first")
  await writer.write("second")
  const write = spyOn(process.stdout, "write").mockImplementation((text) => {
    events.push(String(text))
    return true
  })
  cleanups.push(() => write.mockRestore())
  worker.listeners.get("error")?.()
  await writer.flush()
  expect(events).toEqual(["guard", "first", "guard", "second", "guard", "first", "guard", "second"])
})
