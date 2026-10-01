import type { ToolSpec } from "@amira/ai"
import type { ToolDefinition, ToolSession } from "@amira/api"
import type { ToolRegistry } from "./tool-registry.ts"

export const TOOL_SEARCH = "tool_search"

/**
 * What the model is offered on a call: active tools, then the deferred ones this session
 * loaded (in load order). tool_search itself is only offered while something is deferred.
 * `allow` leaves out tools this model may not use (the agent's toolRestriction): those its
 * hosted web search stands in for, and the editing tool its settings did not choose.
 */
export function offeredTools(
  registry: ToolRegistry,
  loaded: Iterable<string>,
  allow: (tool: ToolDefinition) => boolean = () => true,
): ToolSpec[] {
  const deferred = registry.deferred().filter(allow)
  const active = registry
    .active()
    .filter(allow)
    .filter((t) => t.name !== TOOL_SEARCH || deferred.length > 0)
  const byName = new Map(deferred.map((t) => [t.name, t]))
  const extra: ToolDefinition[] = []
  for (const name of loaded) {
    const t = byName.get(name)
    if (t) extra.push(t)
  }
  return [...active, ...extra].map((t) => ({
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
  allow: (tool: ToolDefinition) => boolean = () => true,
): Pick<ToolSession, "sessionId" | "deferredTools" | "loadTools"> {
  return {
    sessionId,
    deferredTools: () =>
      registry
        .deferred()
        .filter(allow)
        .map((t) => ({
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
        const tool = registry.get(name)
        if (tool && !allow(tool)) continue
        const exposure = tool?.exposure
        if (loaded.has(name) || (exposure && exposure !== "deferred")) continue
        loaded.add(name)
        added.push(name)
      }
      return added
    },
  }
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? ""
  return line.length > 160 ? `${line.slice(0, 157)}...` : line
}
