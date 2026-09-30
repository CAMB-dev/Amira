import type { ToolSpec } from "@amira/ai"
import {
  type DeferredToolInfo,
  defineExtension,
  defineTool,
  type ToolDefinition,
  type ToolSession,
  textResult,
} from "@amira/api"
import type { ToolRegistry } from "./tool-registry.ts"

export const TOOL_SEARCH = "tool_search"

/**
 * What the model is offered on a call: active tools, then the deferred ones this session
 * loaded (in load order). tool_search itself is only offered while something is deferred.
 * `nativeWebSearch`: the model searches on the provider's side, so tools that would do the
 * same (supersededBy "webSearch") are left out.
 */
export function offeredTools(
  registry: ToolRegistry,
  loaded: Iterable<string>,
  opts: { nativeWebSearch?: boolean } = {},
): ToolSpec[] {
  const deferred = registry.deferred()
  const active = registry.active().filter((t) => t.name !== TOOL_SEARCH || deferred.length > 0)
  const byName = new Map(deferred.map((t) => [t.name, t]))
  const extra: ToolDefinition[] = []
  for (const name of loaded) {
    const t = byName.get(name)
    if (t) extra.push(t)
  }
  const superseded = (t: ToolDefinition) => opts.nativeWebSearch === true && t.supersededBy === "webSearch"
  return [...active, ...extra]
    .filter((t) => !superseded(t))
    .map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))
}

/** The system prompt section naming every deferred tool; empty when there are none. */
export function deferredToolsSection(tools: ToolDefinition[]): string {
  if (!tools.length) return ""
  const lines = tools.map((t) => `- ${t.name}: ${firstLine(t.description)}`)
  return [
    "# Deferred tools",
    `These tools are available but not loaded, so their parameters are unknown to you. Before using one, call ${TOOL_SEARCH} with its exact name (or with keywords to find one); it returns the definitions and loads the tools for the rest of the session.`,
    ...lines,
  ].join("\n")
}

/** The per-session view of deferred tools handed to tools through their context. */
export function createToolSession(
  sessionId: string,
  registry: ToolRegistry,
  loaded: Set<string>,
): Pick<ToolSession, "sessionId" | "deferredTools" | "loadTools"> {
  return {
    sessionId,
    deferredTools: () =>
      registry.deferred().map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        loaded: loaded.has(t.name),
      })),
    // Names not registered yet are remembered too: MCP tools register in the background, so a
    // restored session may load them before they exist. offeredTools() filters at call time.
    loadTools: (names) => {
      const added: string[] = []
      for (const name of names) {
        const exposure = registry.get(name)?.exposure
        if (loaded.has(name) || (exposure && exposure !== "deferred")) continue
        loaded.add(name)
        added.push(name)
      }
      return added
    },
  }
}

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

/** Registers tool_search through the public API, like any other built-in (D27). */
export const toolSearchExtension = defineExtension((api) => {
  api.registerTool(toolSearchTool)
})

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? ""
  return line.length > 160 ? `${line.slice(0, 157)}...` : line
}
