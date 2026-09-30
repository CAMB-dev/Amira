import {
  type AssistantContent,
  type Citation,
  describeServerTool,
  messageCitations,
  type ServerToolBlock,
} from "@amira/ai"
import type { ToolResult, WebSearchDetails } from "@amira/api"

/** The backend a hosted web search row names in its details. */
export const PROVIDER_SEARCH = "provider search"

/**
 * A tool the provider ran (its hosted web search) as a tool row shows it: under its name, with
 * what it searched or opened as the arguments and the sources as the result. `rejected` is
 * set for one that never finished.
 */
export function serverToolCall(b: ServerToolBlock): {
  name: string
  args: Record<string, unknown>
  result: ToolResult
  rejected?: "aborted"
} {
  const input = b.input
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "")
  const queries = Array.isArray(input.queries)
    ? input.queries.filter((q): q is string => typeof q === "string" && q !== "")
    : []
  const query = queries.length ? queries.join(" · ") : str("query")
  const args: Record<string, unknown> =
    input.type === "open_page" || input.type === "find_in_page"
      ? { url: str("url"), ...(str("pattern") ? { pattern: str("pattern") } : {}) }
      : query
        ? { query }
        : {}
  const sources = b.sources ?? []
  const details: WebSearchDetails & { native: true } = {
    backend: PROVIDER_SEARCH,
    results: sources.map((s) => ({ title: s.title ?? s.url, url: s.url })),
    failures: [],
    native: true,
  }
  const text = [describeServerTool(b), ...sources.map((s) => `${s.title ? `${s.title} ` : ""}${s.url}`)].join(
    "\n",
  )
  return {
    name: b.name,
    args,
    result: {
      content: [{ type: "text", text }],
      details,
      ...(b.status === "failed" ? { isError: true } : {}),
    },
    ...(b.status === "running" ? { rejected: "aborted" as const } : {}),
  }
}

/** Link text in Markdown: brackets and backslashes escaped, on one line. */
function linkText(s: string): string {
  return s.replace(/\s+/g, " ").replace(/[\\[\]]/g, (c) => `\\${c}`)
}

/** Markdown after a reply that cites sources: each one, once, as a link under its title. */
export function citationsMarkdown(citations: Citation[]): string {
  if (!citations.length) return ""
  // A URL with brackets, spaces or parentheses would end the link early: those are escaped.
  const target = (url: string) =>
    url.replace(/[\s()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)
  const items = citations.map((c, i) => `${i + 1}. [${linkText(c.title || c.url)}](${target(c.url)})`)
  return `\n\nSources:\n${items.join("\n")}`
}

/** The sources a reply's text cites, as Markdown to show after it (citationsMarkdown). */
export function replyCitations(content: readonly AssistantContent[]): string {
  return citationsMarkdown(messageCitations(content))
}
