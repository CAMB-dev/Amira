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

export const webSearchPresenter: ToolPresenter<{ query: string }, WebSearchDetails> = {
  summary: (args) => `"${str(args.query)}"`,
  result(call) {
    if (call.result.isError) return undefined
    const d = detailsOf<WebSearchDetails>(call, "results")
    if (!d) return undefined
    const n = d.results.length
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
