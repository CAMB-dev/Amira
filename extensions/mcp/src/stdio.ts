import { type FromPipeWorker, openPipe, type PipeEvent, type PipeHandle, type PipeSpec } from "./pipe.ts"
import type { JsonRpcMessage, Transport } from "./transport.ts"

/**
 * Server processes (or their launchers) that have not exited yet, from spawn until exit, so
 * a server still inside its close grace period is covered too.
 */
const livePids = new Set<number>()
let exitHookInstalled = false

/**
 * Kills the trees of servers still running when Amira exits. Workers are gone by then, so
 * this is the one spawn on the main thread: taskkill /T, because killing only a launcher
 * (cmd.exe, npx.cmd) leaves the real server running on Windows.
 */
export function killLiveServers(): void {
  if (!livePids.size) return
  const pids = [...livePids]
  livePids.clear()
  if (process.platform === "win32") {
    try {
      Bun.spawnSync(["taskkill", "/T", "/F", ...pids.flatMap((p) => ["/PID", String(p)])], {
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
    } catch {}
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
}

function track(pid: number) {
  livePids.add(pid)
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once("exit", killLiveServers)
}

// A compiled binary needs pipe-worker.ts as an extra entrypoint at this same relative path.
let workerUrl = new URL("./pipe-worker.ts", import.meta.url).href
/** Workers could not be loaded once; later servers spawn on the main thread. */
let workersBroken = false

/** Test hook: load the pipe worker from elsewhere (e.g. a missing file, to test the fallback). */
export function setPipeWorkerUrl(url?: string): void {
  workerUrl = url ?? new URL("./pipe-worker.ts", import.meta.url).href
  workersBroken = false
}

export interface StdioOptions {
  /** How long the server gets to exit after stdin closes before it is killed. Default 2000 ms. */
  closeGraceMs?: number
  onStderr?: (text: string) => void
}

/**
 * Speaks newline-delimited JSON-RPC over a server's stdin/stdout. The process is spawned and
 * owned by a dedicated worker thread, so a slow spawn never stalls the main thread.
 */
export class StdioTransport implements Transport {
  onmessage?: (message: JsonRpcMessage) => void
  onclose?: (reason: string) => void
  protocolVersion?: string
  /** Process id of the server (or its launcher) once spawned. */
  pid: number | undefined

  #spec: PipeSpec
  #opts: StdioOptions
  #pipe: { write(data: string): void; close(graceMs: number): void; dispose(): void } | undefined
  #buffer = ""
  #stderrTail = ""
  #closed = false

  constructor(spec: PipeSpec, opts: StdioOptions = {}) {
    this.#spec = spec
    this.#opts = opts
  }

  /** The end of the server's stderr, for error messages. */
  get stderrTail(): string {
    return this.#stderrTail.trim()
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      let started = false
      const onEvent = (e: PipeEvent) => {
        if (e.type === "spawned") {
          this.pid = e.pid
          track(e.pid)
          started = true
          resolve()
        } else if (e.type === "stdout") this.#onStdout(e.data)
        else if (e.type === "stderr") this.#onStderr(e.data)
        else {
          // Without an error the process really exited; a lost worker may have left it running.
          if (this.pid !== undefined && !e.error) livePids.delete(this.pid)
          const reason =
            e.error ?? `exited with code ${e.code}${this.stderrTail ? `: ${this.stderrTail}` : ""}`
          this.#pipe?.dispose()
          if (!started) reject(new Error(`could not start ${this.#spec.argv[0]}: ${reason}`))
          else if (!this.#closed) {
            this.#closed = true
            this.onclose?.(`server process ${reason}`)
          }
        }
      }
      this.#pipe = workersBroken ? inlinePipe(this.#spec, onEvent) : workerPipe(this.#spec, onEvent)
    })
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.#closed || !this.#pipe) throw new Error("the server connection is closed")
    this.#pipe.write(`${JSON.stringify(message)}\n`)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#pipe?.close(this.#opts.closeGraceMs ?? 2000)
  }

  #onStdout(data: string) {
    this.#buffer += data
    let nl = this.#buffer.indexOf("\n")
    while (nl >= 0) {
      const line = this.#buffer.slice(0, nl).trim()
      this.#buffer = this.#buffer.slice(nl + 1)
      if (line) {
        let msg: unknown
        try {
          msg = JSON.parse(line)
        } catch {
          // Not protocol traffic (a server logging to stdout); treat it like stderr.
          this.#onStderr(`${line}\n`)
        }
        if (msg && typeof msg === "object") this.onmessage?.(msg as JsonRpcMessage)
      }
      nl = this.#buffer.indexOf("\n")
    }
  }

  #onStderr(data: string) {
    this.#stderrTail = (this.#stderrTail + data).slice(-2000)
    this.#opts.onStderr?.(data)
  }
}

function workerPipe(spec: PipeSpec, onEvent: (e: PipeEvent) => void) {
  let worker: Worker
  try {
    worker = new Worker(workerUrl)
  } catch {
    workersBroken = true
    return inlinePipe(spec, onEvent)
  }
  worker.unref()
  let ready = false
  let fallback: ReturnType<typeof inlinePipe> | undefined
  const pending: string[] = []
  let closeGrace: number | undefined
  let disposed = false
  const gone = () => {
    if (disposed || fallback) return
    if (ready) {
      disposed = true
      onEvent({ type: "exit", code: null, error: "the pipe worker stopped unexpectedly" })
      return
    }
    // The worker module never loaded: spawn here instead.
    workersBroken = true
    worker.terminate()
    fallback = inlinePipe(spec, onEvent)
    for (const d of pending) fallback.write(d)
    if (closeGrace !== undefined) fallback.close(closeGrace)
  }
  worker.addEventListener("error", gone)
  worker.addEventListener("close", gone)
  worker.onmessage = (e: MessageEvent<FromPipeWorker>) => {
    if (e.data.type === "ready") {
      ready = true
      pending.length = 0
      return
    }
    onEvent(e.data)
  }
  worker.postMessage({ type: "open", spec })
  return {
    write(data: string) {
      if (fallback) return fallback.write(data)
      if (!ready) pending.push(data)
      worker.postMessage({ type: "write", data })
    },
    close(graceMs: number) {
      if (fallback) return fallback.close(graceMs)
      closeGrace = graceMs
      worker.postMessage({ type: "close", graceMs })
    },
    dispose() {
      if (fallback || disposed) return
      disposed = true
      // Let the worker finish posting, then free the thread.
      setTimeout(() => worker.terminate(), 0)
    },
  }
}

function inlinePipe(spec: PipeSpec, onEvent: (e: PipeEvent) => void) {
  let handle: PipeHandle | undefined
  // Deferred so start() callers see the same asynchronous shape as with a worker.
  const queue: ((h: PipeHandle) => void)[] = []
  setTimeout(() => {
    handle = openPipe(spec, onEvent)
    for (const q of queue) q(handle)
  }, 0)
  const run = (f: (h: PipeHandle) => void) => (handle ? f(handle) : queue.push(f))
  return {
    write: (data: string) => void run((h) => h.write(data)),
    close: (graceMs: number) => void run((h) => h.close(graceMs)),
    dispose() {},
  }
}
