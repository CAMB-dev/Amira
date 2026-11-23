import { chromeText } from "../glyphs.ts"
import { INTERRUPTED_NOTICE } from "../transcript.ts"

export function runningJobCount(read?: () => number): number {
  try {
    return read?.() ?? 0
  } catch {
    return 0
  }
}

export function interruptedText(children: number): string {
  return children
    ? chromeText(
        `${INTERRUPTED_NOTICE} · ${children} sub-agent${children === 1 ? "" : "s"} still running · /agents`,
      )
    : INTERRUPTED_NOTICE
}

export function quitWarning(children: number, jobs: number, key: string): string {
  const what = [
    children ? `${children} sub-agent${children === 1 ? "" : "s"}` : "",
    jobs ? `${jobs} background job${jobs === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" and ")
  return `${what} still running — ${key} again to stop ${children + jobs === 1 ? "it" : "them"} and quit`
}
