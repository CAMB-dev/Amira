import { splitLines } from "./diff.ts"

/** Worker startup is bounded separately from each batch's regex and message delivery budget. */
const WORKER_STARTUP_TIMEOUT_MS = 30_000
const MATCH_TIMEOUT_MS = 1_000
export const MAX_TESTED_LINE_CHARS = 10_000

// Inline source also works in compiled binaries: there is no extra worker entrypoint to ship.
// Batch many files, not one message per line or file, and reuse the worker throughout a search.
// Each file goes as its text, split in the worker: one string copies far faster than its lines.
const source = `
const splitLines = ${splitLines.toString()}
self.onmessage = ({ data: { pattern, flags, texts, firstOnly, maxChars } }) => {
  const re = new RegExp(pattern, flags)
  self.postMessage(texts.map((text) => {
    const lines = splitLines(text)
    const matches = []
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i].slice(0, maxChars))) continue
      matches.push(i)
      if (firstOnly) break
    }
    return matches
  }))
}
self.postMessage("ready")
`

/** One matcher per call: aborting or timing out must not disrupt concurrent searches. */
export function grepMatcher(re: RegExp, signal: AbortSignal) {
  // Only regexes with NO syntax take the inline path. Do not try to guess whether arbitrary
  // regex syntax is safe: nested quantifiers are not the only source of exponential work.
  const literal = !/[\\^$.*+?()[\]{}|]/.test(re.source)
  let worker: Worker | undefined
  let url: string | undefined
  let ready = false
  let cancel: (() => void) | undefined
  const stopWorker = () => {
    worker?.terminate()
    worker = undefined
    ready = false
    if (url) URL.revokeObjectURL(url)
    url = undefined
  }
  const close = () => {
    cancel?.()
    stopWorker()
  }

  return {
    close,
    /** The indices of each text's matching lines, as `splitLines` numbers them (only the first with `firstOnly`). */
    async match(texts: string[], firstOnly: boolean): Promise<number[][]> {
      if (signal.aborted) throw new Error("Aborted")
      if (literal) {
        return texts.map((text) => {
          const lines = splitLines(text)
          const matches: number[] = []
          for (let i = 0; i < lines.length; i++) {
            if (!re.test(lines[i]!.slice(0, MAX_TESTED_LINE_CHARS))) continue
            matches.push(i)
            if (firstOnly) break
          }
          return matches
        })
      }
      if (!worker) {
        try {
          url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }))
          worker = new Worker(url)
        } catch {
          stopWorker()
          throw new Error("The grep matching worker failed")
        }
      }
      const w = worker
      return new Promise<number[][]>((resolve, reject) => {
        let settled = false
        let timer: ReturnType<typeof setTimeout> | undefined
        const finish = (error?: Error, matches?: number[][]) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal.removeEventListener("abort", onAbort)
          w.onmessage = null
          w.removeEventListener("error", onError)
          w.removeEventListener("close", onClose)
          cancel = undefined
          if (error) {
            stopWorker()
            reject(error)
          } else resolve(matches!)
        }
        const onAbort = () => finish(new Error("Aborted"))
        const onError = (event?: Event) => {
          event?.preventDefault()
          finish(new Error("The grep matching worker failed"))
        }
        const onClose = () => finish(new Error("The grep matching worker stopped unexpectedly"))
        const startMatching = () => {
          clearTimeout(timer)
          timer = setTimeout(
            () =>
              finish(
                new Error(
                  "Regular expression matching timed out (1 second for a batch of files). No results were returned. " +
                    "Simplify the pattern: avoid nested quantifiers such as (a+)+ and overlapping alternatives; " +
                    "use a literal or a bounded repetition instead. You can also narrow path or glob.",
                ),
              ),
            MATCH_TIMEOUT_MS,
          )
          try {
            w.postMessage({
              pattern: re.source,
              flags: re.flags,
              texts,
              firstOnly,
              maxChars: MAX_TESTED_LINE_CHARS,
            })
          } catch {
            onError()
          }
        }
        w.onmessage = (event: MessageEvent<"ready" | number[][]>) => {
          if (!ready && event.data === "ready") {
            ready = true
            startMatching()
          } else if (ready && event.data !== "ready") finish(undefined, event.data)
        }
        w.addEventListener("error", onError)
        w.addEventListener("close", onClose)
        signal.addEventListener("abort", onAbort, { once: true })
        cancel = onClose
        if (signal.aborted) onAbort()
        else if (ready) startMatching()
        else {
          timer = setTimeout(
            () => finish(new Error("The grep matching worker failed to start within 30 seconds")),
            WORKER_STARTUP_TIMEOUT_MS,
          )
        }
      })
    },
  }
}
