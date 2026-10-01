import type { AssistantMessage, ServerToolBlock, Usage } from "@amira/ai"

/** A usage value with all token counters at zero. */
export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

/** Adds token and search usage, keeping cost unknown when an included search was not priced. */
export function addUsage(a: Usage, b: Usage): Usage {
  const sum: Usage = {
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
export function hasUnpricedSearch(message: Pick<AssistantMessage, "content" | "usage">): boolean {
  return (
    message.usage?.cost === undefined &&
    ((message.usage?.webSearchRequests ?? 0) > 0 ||
      message.content.some((b) => b.type === "serverTool" && b.name === "web_search"))
  )
}

/** "Web search: \"node lts\"", "Web search opened https://…", for notes and frontends. */
export function describeServerTool(b: Pick<ServerToolBlock, "name" | "input">): string {
  const label = b.name === "web_search" ? "Web search" : b.name
  const input = b.input
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "")
  const queries = Array.isArray(input.queries)
    ? input.queries.filter((query): query is string => typeof query === "string" && query !== "")
    : []
  if (input.type === "open_page" && str("url")) return `${label}: opened ${str("url")}`
  if (input.type === "find_in_page" && str("url")) {
    return `${label}: looked for "${str("pattern")}" in ${str("url")}`
  }
  const all = queries.length ? queries : str("query") ? [str("query")] : []
  return all.length ? `${label}: ${all.map((query) => `"${query}"`).join(", ")}` : label
}

/** A server tool's call as a short note for a model that cannot take its provider-native item. */
export function serverToolText(b: ServerToolBlock): string {
  const what = describeServerTool(b)
  const sources = (b.sources ?? []).map(
    (source) => `- ${source.title ? `${source.title}: ` : ""}${source.url}`,
  )
  const status = b.status === "failed" ? " (failed)" : b.status === "running" ? " (did not finish)" : ""
  const error =
    b.status === "failed" && typeof b.input.error_code === "string" ? [`Error: ${b.input.error_code}`] : []
  return [`[${what}${status}]`, ...error, ...(sources.length ? ["Sources:", ...sources] : [])].join("\n")
}
