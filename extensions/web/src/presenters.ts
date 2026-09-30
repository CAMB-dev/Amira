import type { ToolCallView, ToolLine, ToolPresenter, WebFetchDetails, WebSearchDetails } from "@amira/api"

/** How web_search and web_fetch calls are shown (D1). */

const str = (v: unknown) => (typeof v === "string" ? v : "")

function detailsOf<D>(call: ToolCallView<any, unknown>, key: keyof D): D | undefined {
  const d = call.result.details
  return d && typeof d === "object" && key in d ? (d as D) : undefined
}

const textLines = (text: string): ToolLine[] => text.split("\n").map((t) => ({ kind: "code", text: t }))

/** "812 chars", "12.3k chars" */
function size(chars: number): string {
  return chars < 1000 ? `${chars} chars` : `${(chars / 1000).toFixed(1)}k chars`
}

/**
 * Also shows the provider's hosted web search (the TUI's rows for it carry `native` details):
 * it searches (`query`), opens a page (`url`) or looks for a `pattern` in one.
 */
export const webSearchPresenter: ToolPresenter<
  { query?: string; url?: string; pattern?: string },
  WebSearchDetails & { native?: boolean }
> = {
  summary(args) {
    if (args.query !== undefined) return `"${str(args.query)}"`
    if (str(args.url)) return str(args.pattern) ? `"${str(args.pattern)}" in ${str(args.url)}` : str(args.url)
    // A hosted search may not say what it looked for.
    return ""
  },
  result(call) {
    if (call.result.isError) return undefined
    const d = detailsOf<WebSearchDetails & { native?: boolean }>(call, "results")
    if (!d) return undefined
    const n = d.results.length
    if (d.native) return n ? `${n} source${n === 1 ? "" : "s"} · ${d.backend}` : d.backend
    return `${n} result${n === 1 ? "" : "s"} · ${d.backend}`
  },
  body: (call, { detail }) => (detail === "full" && !call.result.isError ? textLines(call.text) : []),
}

export const webFetchPresenter: ToolPresenter<{ url: string }, WebFetchDetails> = {
  summary: (args) => str(args.url),
  result(call) {
    if (call.result.isError) return undefined
    const d = detailsOf<WebFetchDetails>(call, "finalUrl")
    if (!d) return undefined
    const moved = d.finalUrl !== d.url ? `→ ${d.finalUrl} · ` : ""
    const status = d.status >= 200 && d.status < 300 ? "" : ` · HTTP ${d.status}`
    return `${moved}${size(d.length)}${status}`
  },
  body: (call, { detail }) => (detail === "full" && !call.result.isError ? textLines(call.text) : []),
}
