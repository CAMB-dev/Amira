import type { ServerToolBlock } from "@amira/ai"
import { describeServerTool } from "./ai.ts"
import type { WebSearchDetails } from "./tool-details.ts"
import { type ToolCallView, toolResultText } from "./tool-renderers.ts"
import type { ToolResult } from "./tools.ts"

/** The backend name used for provider-hosted web searches. */
export const PROVIDER_SEARCH = "provider search"

/**
 * A provider-hosted tool in the same shape frontends use for a completed local tool call.
 * It has no local execution or duration: `rejected` marks one that was still running when the
 * reply ended. The result's native search details keep its sources available to presenters.
 */
export interface ServerToolView
  extends ToolCallView<Record<string, unknown>, WebSearchDetails & { native: true }> {
  /** What the provider ran, e.g. "web_search". */
  name: string
}

/**
 * Presents provider-hosted tools (such as native web search) consistently for extensions and
 * frontends. The returned text, result and native-search details are safe to render; do not
 * send them back to a provider as a local tool result.
 */
export function serverToolView(block: ServerToolBlock): ServerToolView {
  const input = block.input
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "")
  const queries = Array.isArray(input.queries)
    ? input.queries.filter((query): query is string => typeof query === "string" && query !== "")
    : []
  const query = queries.length ? queries.join(" · ") : str("query")
  const args: Record<string, unknown> =
    input.type === "open_page" || input.type === "find_in_page"
      ? { url: str("url"), ...(str("pattern") ? { pattern: str("pattern") } : {}) }
      : query
        ? { query }
        : {}
  const sources = block.sources ?? []
  const details: WebSearchDetails & { native: true } = {
    backend: PROVIDER_SEARCH,
    results: sources.map((source) => ({ title: source.title ?? source.url, url: source.url })),
    failures: [],
    native: true,
  }
  const error = block.status === "failed" && str("error_code") ? [`Error: ${str("error_code")}`] : []
  const text = [
    describeServerTool(block),
    ...error,
    ...sources.map((source) => `${source.title ? `${source.title} ` : ""}${source.url}`),
  ].join("\n")
  const result: ToolResult & { details: WebSearchDetails & { native: true } } = {
    content: [{ type: "text", text }],
    details,
    ...(block.status === "failed" ? { isError: true } : {}),
  }
  return {
    name: block.name,
    args,
    result,
    text: toolResultText(result),
    ...(block.status === "running" ? { rejected: "aborted" as const } : {}),
  }
}
