/**
 * Runtime helpers over message shapes that both @amira/ai and @amira/api expose, kept in this
 * dependency-free leaf so the API need not load the ai package and there is one implementation.
 * The shapes here are structural; @amira/ai's Usage and ServerToolBlock satisfy them, and both
 * packages re-export these functions typed with their own types.
 */

/** The name a hosted web search goes by, in blocks and in frontends. */
export const NATIVE_WEB_SEARCH = "web_search"

/** Token and search counters, as in @amira/ai's Usage. */
export interface UsageCounts {
  input: number
  output: number
  reasoning?: number
  cacheRead: number
  cacheWrite: number
  webSearchRequests?: number
  webSearchCost?: number
  cost?: number
}

/** What these helpers read of a server tool block (@amira/ai's ServerToolBlock). */
export interface ServerToolCall {
  name: string
  input: Record<string, unknown>
  status: "running" | "done" | "failed"
  sources?: { url: string; title?: string }[]
}

/** A usage value with all token counters at zero. */
export function emptyUsage(): UsageCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

/** Adds token and search usage, keeping cost unknown when an included search was not priced. */
export function addUsage(a: UsageCounts, b: UsageCounts): UsageCounts {
  const sum: UsageCounts = {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
  if (a.cost !== undefined || b.cost !== undefined) sum.cost = (a.cost ?? 0) + (b.cost ?? 0)
  if (a.webSearchRequests !== undefined || b.webSearchRequests !== undefined)
    sum.webSearchRequests = (a.webSearchRequests ?? 0) + (b.webSearchRequests ?? 0)
  const unknownSearch = [a, b].some((u) => (u.webSearchRequests ?? 0) > 0 && u.webSearchCost === undefined)
  if (unknownSearch) delete sum.cost
  else if (a.webSearchCost !== undefined || b.webSearchCost !== undefined)
    sum.webSearchCost = (a.webSearchCost ?? 0) + (b.webSearchCost ?? 0)
  return sum
}

/** A reported search or server search block whose total cost could not be priced. */
export function hasUnpricedSearch(message: {
  content: readonly { type: string; name?: string }[]
  usage?: UsageCounts
}): boolean {
  return (
    message.usage?.cost === undefined &&
    ((message.usage?.webSearchRequests ?? 0) > 0 ||
      message.content.some((b) => b.type === "serverTool" && b.name === NATIVE_WEB_SEARCH))
  )
}

/**
 * A server tool's call as a short note, for a model that cannot take its item: another
 * dialect, or one the ai client left no item for (forReplay, canReplayServerTool).
 */
export function serverToolText(b: ServerToolCall): string {
  const what = describeServerTool(b)
  const sources = (b.sources ?? []).map((s) => `- ${s.title ? `${s.title}: ` : ""}${s.url}`)
  const status = b.status === "failed" ? " (failed)" : b.status === "running" ? " (did not finish)" : ""
  const error =
    b.status === "failed" && typeof b.input.error_code === "string" ? [`Error: ${b.input.error_code}`] : []
  return [`[${what}${status}]`, ...error, ...(sources.length ? ["Sources:", ...sources] : [])].join("\n")
}

/** "Web search: \"node lts\"", "Web search opened https://…", for notes and frontends. */
export function describeServerTool(b: Pick<ServerToolCall, "name" | "input">): string {
  const label = b.name === NATIVE_WEB_SEARCH ? "Web search" : b.name
  const input = b.input
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "")
  const queries = Array.isArray(input.queries)
    ? input.queries.filter((q): q is string => typeof q === "string" && q !== "")
    : []
  if (input.type === "open_page" && str("url")) return `${label}: opened ${str("url")}`
  if (input.type === "find_in_page" && str("url")) {
    return `${label}: looked for "${str("pattern")}" in ${str("url")}`
  }
  const all = queries.length ? queries : str("query") ? [str("query")] : []
  return all.length ? `${label}: ${all.map((q) => `"${q}"`).join(", ")}` : label
}
