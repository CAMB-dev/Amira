import { consoleCodePage } from "@amira/tui-kit/console-code-page"

export type ToStdoutWorker = { seq: number; text: string }
export type FromStdoutWorker =
  | { type: "ready" }
  | { type: "written"; seq: number }
  | { type: "closed"; error: string }

export interface StdoutWriter {
  /** Queues text; resolves once less than the window is waiting for the pipe. */
  write(text: string): Promise<void>
  /** Resolves once everything written so far reached stdout. */
  flush(): Promise<void>
  close(): void
}

export interface StdoutWriterOptions {
  /** Bytes that may wait for the pipe before write() holds the caller back. Default 64 KiB. */
  window?: number
  /** stdout failed, e.g. the reader went away. */
  onClosed?: (error: string) => void
}

const workerUrl = new URL("./stdout-worker.ts", import.meta.url).href

/**
 * stdout with real backpressure. Bun's own stdout writes either buffer without limit or block
 * the whole thread on a full pipe, so a worker does the blocking writes and the main thread
 * waits on its acknowledgements. Falls back to process.stdout when no worker can start
 * (a compiled binary needs stdout-worker.ts as an extra entrypoint at this relative path).
 */
export function stdoutWriter(opts: StdoutWriterOptions = {}): StdoutWriter {
  const window = opts.window ?? 64 * 1024
  const queue: { seq: number; text: string; bytes: number }[] = []
  let inflight = 0
  let seq = 0
  let ready = false
  let closed = false
  let waiters: (() => void)[] = []
  let worker: Worker | undefined

  const wake = () => {
    const w = waiters
    waiters = []
    for (const f of w) f()
  }
  const fallback = () => {
    worker?.terminate()
    worker = undefined
    for (const item of queue.splice(0)) {
      consoleCodePage.ensure()
      process.stdout.write(item.text)
    }
    inflight = 0
    wake()
  }
  const close = (error: string) => {
    if (closed) return
    closed = true
    queue.length = 0
    inflight = 0
    wake()
    opts.onClosed?.(error)
  }

  try {
    const w = new Worker(workerUrl)
    w.onmessage = (e: MessageEvent<FromStdoutWorker>) => {
      const m = e.data
      ready = true
      if (m.type === "closed") return close(m.error)
      if (m.type !== "written") return
      while (queue.length && queue[0]!.seq <= m.seq) inflight -= queue.shift()!.bytes
      wake()
    }
    const gone = () => {
      if (worker !== w) return
      if (!ready) fallback()
      else close("the stdout worker stopped")
    }
    w.addEventListener("error", gone)
    w.addEventListener("close", gone)
    worker = w
  } catch {
    worker = undefined
  }

  const settled = (limit: number) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (closed || inflight <= limit) resolve()
        else waiters.push(check)
      }
      check()
    })

  return {
    write(text) {
      if (closed) return Promise.resolve()
      // Console CPs are shared across threads; assert before posting each worker batch too.
      consoleCodePage.ensure()
      if (!worker) {
        process.stdout.write(text)
        return Promise.resolve()
      }
      const bytes = Buffer.byteLength(text)
      queue.push({ seq: ++seq, text, bytes })
      inflight += bytes
      worker.postMessage({ seq, text } satisfies ToStdoutWorker)
      return settled(window)
    },
    flush: () => settled(0),
    close() {
      const w = worker
      worker = undefined
      w?.terminate()
    },
  }
}
