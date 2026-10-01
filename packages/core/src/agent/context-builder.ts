import { hasNativeWebSearch, type Message, type ModelInfo, type ToolSpec } from "@amira/ai"
import type { ProviderSettings, ToolDefinition } from "@amira/api"
import { type ContextView, projectMessages } from "../context.ts"
import { deferredToolsSection, offeredTools as registryOfferedTools } from "../deferred-tools.ts"
import type { InterceptOutcome, InterceptorRegistry } from "../interceptors.ts"
import { type PromptSection, renderPrompt, setSection } from "../prompt.ts"
import type { ToolRegistry } from "../tool-registry.ts"
import { toolTraits } from "../tool-traits.ts"

/** Why this model cannot use a registered tool, independent of explicit disabled tools. */
export function toolRestriction(
  tool: ToolDefinition,
  model: ModelInfo,
  providerSettings: Record<string, ProviderSettings>,
): string | undefined {
  if (hasNativeWebSearch(model) && tool.supersededBy === "webSearch") {
    return `the current model uses the provider's hosted web search`
  }
  const provider = providerSettings[model.provider]
  const editing =
    provider?.models?.find((m) => m.id === model.id)?.tools?.edit ?? provider?.tools?.edit ?? "edit"
  const editor = toolTraits(tool)?.editor
  if (editor !== undefined && editor !== editing && editing !== "both") {
    return `the editing tool choice for ${model.provider}/${model.id} is "${editing}". Set providers.${model.provider}.tools.edit or this model's models[].tools.edit to "${tool.name}" or "both" in settings.json and restart the session`
  }
  return undefined
}

/** The tools a model gets after registry and model-specific filters. */
export function offeredTools(
  registry: ToolRegistry,
  loaded: Iterable<string>,
  allow: (tool: ToolDefinition) => boolean,
): ToolSpec[] {
  return registryOfferedTools(registry, loaded, allow)
}

/** Deferred tools this model may load, after its provider and model choices. */
export function offeredDeferredTools(
  registry: ToolRegistry,
  allow: (tool: ToolDefinition) => boolean,
): ToolDefinition[] {
  return registry.deferred().filter(allow)
}

export interface ContextBuildOptions {
  /** The agent's current sections, read before system.build starts. */
  sections: PromptSection[]
  /** Re-reads the current model-visible deferred tools after system.build has awaited. */
  offeredDeferred: () => ToolDefinition[]
  /** Re-reads the current conversation projection after system.build has awaited. */
  messages: () => readonly Message[]
  views: () => ReadonlyMap<Message, ContextView>
  interceptors: InterceptorRegistry
  sessionId: string
  signal: AbortSignal
}

/** Builds the system prompt and projected history through both request interceptors. */
export async function buildContext(
  options: ContextBuildOptions,
): Promise<InterceptOutcome<{ systemPrompt: string; messages: Message[] }>> {
  // The core owns the "deferred-tools" section: interceptors see it filled in, and it is
  // listed again afterwards so tools registered while they waited (e.g. MCP servers that
  // were still connecting) are included, unless an interceptor rewrote the section.
  const listed = deferredToolsSection(options.offeredDeferred())
  const built = await options.interceptors.run(
    "system.build",
    { sections: setSection(options.sections, "deferred-tools", listed).map((s) => ({ ...s })) },
    { sessionId: options.sessionId, signal: options.signal },
  )
  let sections = built.value.sections
  if (sections.find((s) => s.name === "deferred-tools")?.text === listed) {
    sections = setSection(sections, "deferred-tools", deferredToolsSection(options.offeredDeferred()))
  }
  return options.interceptors.run(
    "context.build",
    { systemPrompt: renderPrompt(sections), messages: projectMessages(options.messages(), options.views()) },
    { sessionId: options.sessionId, signal: options.signal },
  )
}
