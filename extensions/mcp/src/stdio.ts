import { openPipe, type PipeEvent, type PipeProcess, type PipeSpec } from "@amira/proc"
import type { JsonRpcMessage, Transport } from "./transport.ts"

/**
 * Server processes (or their launchers) that have not exited yet, from spawn until exit, so
 * a server still inside its close grace period is covered too.
 */
const livePids = new Set<number>()
let exitHookInstalled = false

/**
 * Kills the trees of servers still running when Amira exits. Workers are gone by then, so
 * this is the one spawn on the main thread (without pipes, see `openPipe`): taskkill /T,
 * because killing only a launcher (cmd.exe, npx.cmd) leaves the real server running on Windows.
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

export interface StdioOptions {
  /** How long the server gets to exit after stdin closes before it is killed. Default 2000 ms. */
  closeGraceMs?: number
  onStderr?: (text: string) => void
}

/**
 * Speaks newline-delimited JSON-RPC over a server's stdin/stdout. The process is spawned and
 * owned by the command worker of @amira/proc, so a slow spawn never stalls the main thread.
 */
export class StdioTransport implements Transport {
  onmessage?: (message: JsonRpcMessage) => void
  onclose?: (reason: string) => void
  protocolVersion?: string
  /** Process id of the server (or its launcher) once spawned. */
  pid: number | undefined

  #spec: PipeSpec
  #opts: StdioOptions
  #pipe: PipeProcess | undefined
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
          if (!started) reject(new Error(`could not start ${this.#spec.argv[0]}: ${reason}`))
          else if (!this.#closed) {
            this.#closed = true
            this.onclose?.(`server process ${reason}`)
          }
        }
      }
      this.#pipe = openPipe(this.#spec, onEvent)
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
