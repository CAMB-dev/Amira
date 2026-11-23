import { closeSync, openSync, readSync, statSync, writeSync } from "node:fs"
import { open, stat } from "node:fs/promises"
import type { TraceRecord } from "@amira/api"

/** One serialized file queue. Nothing here runs on an agent's event-emission path. */
export class TraceFile {
  pending: TraceRecord[] = []
  retired = false
  failed = false
  #flushing?: Promise<void>
  #flight?: { text: string; offset: number }

  constructor(
    readonly file: string,
    private readonly onError: (error: unknown) => void,
  ) {}

  push(record: TraceRecord) {
    if (!this.retired && !this.failed) this.pending.push(record)
  }

  invalidateFirstTokens() {
    for (const record of this.pending) if (record.type === "model") delete record.firstToken
  }

  flush(): Promise<void> {
    // An earlier append may already be closing its handle. Drain again for records delivered
    // during that close, rather than treating its promise as a barrier for newer records.
    if (this.#flushing) return this.#flushing.then(() => this.flush())
    if (this.retired || this.failed || !this.pending.length) return Promise.resolve()
    this.#flushing = this.#append().finally(() => {
      this.#flushing = undefined
    })
    return this.#flushing
  }

  async #append() {
    if (this.retired || this.failed || !this.pending.length) return
    try {
      // SessionStore is lazy: a planned filename alone must never create a trace.
      try {
        if (!(await stat(this.file)).isFile()) return
      } catch (error) {
        if (missing(error)) return
        throw error
      }
      if (this.retired) return
      const file = `${this.file}.trace.jsonl`
      const handle = await open(file, "r+").catch((error: unknown) => {
        if (!missing(error)) throw error
        return open(file, "wx+")
      })
      try {
        let position = (await handle.stat()).size
        const tail = Buffer.alloc(1)
        if (position) await handle.read(tail, 0, 1, position - 1)
        // Isolate a crashed run's partial line so the next header remains independently readable.
        let separator = position && tail[0] !== 10 ? "\n" : ""
        while (!this.retired && this.pending.length) {
          const text = separator + this.pending.map((record) => `${JSON.stringify(record)}\n`).join("")
          separator = ""
          this.pending = []
          this.#flight = { text, offset: position }
          const bytes = Buffer.from(text)
          let written = 0
          while (written < bytes.length) {
            const result = await handle.write(bytes, written, bytes.length - written, position + written)
            if (!result.bytesWritten) throw new Error("Trace write made no progress")
            written += result.bytesWritten
          }
          position += bytes.length
          this.#flight = undefined
        }
      } finally {
        await handle.close()
      }
    } catch (error) {
      this.fail(error)
    }
  }

  fail(error: unknown) {
    if (this.failed) return
    this.failed = true
    this.pending = []
    this.#flight = undefined
    this.onError(error)
  }

  /** Exit-only fallback. Fixed offsets make replay of an outstanding write idempotent. */
  emergencyFlush() {
    if (this.retired || this.failed || (!this.pending.length && !this.#flight)) return
    let fd: number | undefined
    try {
      if (!statSync(this.file, { throwIfNoEntry: false })?.isFile()) return
      const file = `${this.file}.trace.jsonl`
      try {
        fd = openSync(file, "r+")
      } catch (error) {
        if (!missing(error)) throw error
        fd = openSync(file, "wx+")
      }
      const offset = this.#flight?.offset ?? statSync(file).size
      const tail = Buffer.alloc(1)
      if (!this.#flight && offset) readSync(fd, tail, 0, 1, offset - 1)
      const prefix = this.#flight?.text ?? (offset && tail[0] !== 10 ? "\n" : "")
      const text = prefix + this.pending.map((record) => `${JSON.stringify(record)}\n`).join("")
      const bytes = Buffer.from(text)
      let written = 0
      while (written < bytes.length) {
        const count = writeSync(fd, bytes, written, bytes.length - written, offset + written)
        if (!count) throw new Error("Trace write made no progress")
        written += count
      }
      this.pending = []
    } catch (error) {
      this.fail(error)
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch (error) {
          this.fail(error)
        }
      }
    }
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
