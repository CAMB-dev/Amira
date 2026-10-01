import { splitLines } from "./diff.ts"

/** Matching budget per batch of files, including worker startup and message delivery. */
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
`

/** One matcher per call: aborting or timing out must not disrupt concurrent searches. */
export function grepMatcher(re: RegExp, signal: AbortSignal) {
  // Only regexes with NO syntax take the inline path. Do not try to guess whether arbitrary
  // regex syntax is safe: nested quantifiers are not the only source of exponential work.
  const literal = !/[\\^$.*+?()[\]{}|]/.test(re.source)
  let worker: Worker | undefined
  let url: string | undefined
  const close = () => {
    worker?.terminate()
    worker = undefined
    if (url) URL.revokeObjectURL(url)
    url = undefined
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
        url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }))
        worker = new Worker(url)
      }
      const w = worker
      return new Promise<number[][]>((resolve, reject) => {
        let settled = false
        const finish = (error?: Error, matches?: number[][]) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal.removeEventListener("abort", onAbort)
          w.onmessage = null
          w.removeEventListener("error", onError)
          w.removeEventListener("close", onClose)
          if (error) {
            close()
            reject(error)
          } else resolve(matches!)
        }
        const onAbort = () => finish(new Error("Aborted"))
        const onError = () => finish(new Error("The grep matching worker failed"))
        const onClose = () => finish(new Error("The grep matching worker stopped unexpectedly"))
        const timer = setTimeout(
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
        w.onmessage = (event: MessageEvent<number[][]>) => finish(undefined, event.data)
        w.addEventListener("error", onError)
        w.addEventListener("close", onClose)
        signal.addEventListener("abort", onAbort, { once: true })
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
      })
    },
  }
}
