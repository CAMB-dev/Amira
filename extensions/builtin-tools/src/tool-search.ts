import { type DeferredToolInfo, defineExtension, defineTool, textResult } from "@amira/api"

export const TOOL_SEARCH = "tool_search"

/** Ranks deferred tools against a query: exact names first, then keyword hits (name weighs more). */
export function searchDeferred(tools: DeferredToolInfo[], query: string, limit: number): DeferredToolInfo[] {
  const q = query.trim().toLowerCase()
  if (q.startsWith("select:")) return pickNames(tools, q.slice(7).split(","))
  const exact = tools.find((t) => t.name.toLowerCase() === q)
  if (exact) return [exact]
  const terms = q.split(/\s+/).filter(Boolean)
  return tools
    .map((t) => {
      const name = t.name.toLowerCase()
      const desc = t.description.toLowerCase()
      let score = 0
      for (const term of terms) score += (name.includes(term) ? 3 : 0) + (desc.includes(term) ? 1 : 0)
      return { t, score }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.t)
}

function pickNames(tools: DeferredToolInfo[], names: string[]): DeferredToolInfo[] {
  const out: DeferredToolInfo[] = []
  for (const raw of names) {
    const name = raw.trim().toLowerCase()
    const t = tools.find((d) => d.name.toLowerCase() === name)
    if (t && !out.includes(t)) out.push(t)
  }
  return out
}

export const toolSearchTool = defineTool<{ query?: string; names?: string[]; max_results?: number }>({
  name: TOOL_SEARCH,
  description: `Loads deferred tools (listed by name in the system prompt) so you can call them, and returns their full definitions.
Pass exact tool names in "names", or a "query": keywords to search names and descriptions, or "select:a,b" for exact names.
Loaded tools stay available for the rest of the session.`,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: 'Keywords, or "select:name1,name2".' },
      names: { type: "array", items: { type: "string" }, description: "Exact tool names to load." },
      max_results: { type: "number", description: "Most tools a keyword query loads. Default 5." },
    },
  },
  async execute(p, ctx) {
    if (!ctx.session) return textResult("tool_search only works inside an agent session.", true)
    const all = ctx.session.deferredTools()
    if (!all.length) return textResult("There are no deferred tools to load.")
    const found = [
      ...(p.names?.length ? pickNames(all, p.names) : []),
      ...(p.query ? searchDeferred(all, p.query, Math.max(1, p.max_results ?? 5)) : []),
    ].filter((t, i, arr) => arr.indexOf(t) === i)
    if (!found.length) {
      const what = p.names?.length ? `named ${p.names.join(", ")}` : `matching "${p.query ?? ""}"`
      return textResult(
        `No deferred tools ${what}. Deferred tools: ${all.map((t) => t.name).join(", ")}`,
        true,
      )
    }
    ctx.session.loadTools(found.map((t) => t.name))
    const defs = found.map(
      (t) =>
        `## ${t.name}\n${t.description.trim()}\nParameters (JSON Schema):\n${JSON.stringify(t.parameters, null, 2)}`,
    )
    const head = `Loaded ${found.length} tool${found.length === 1 ? "" : "s"}; call ${found.length === 1 ? "it" : "them"} directly from now on.`
    return textResult([head, ...defs].join("\n\n"))
  },
})

/** Registers tool_search like any other built-in tool. */
export const toolSearchExtension = defineExtension((api) => {
  api.registerTool(toolSearchTool)
})
