import type { EventEnvelope, EventMap, Intercept, InterceptorMap, InterceptorOptions } from "./events.ts"
import type { ToolDefinition } from "./tools.ts"

export interface InterceptContext {
  sessionId: string
  signal: AbortSignal
}

export interface ExtensionAPI {
  readonly apiVersion: string
  registerTool(tool: ToolDefinition): void
  on<K extends keyof EventMap>(type: K, handler: (event: EventEnvelope<K>) => void): () => void
  intercept<K extends keyof InterceptorMap>(
    point: K,
    handler: (
      value: InterceptorMap[K],
      ctx: InterceptContext,
    ) => Intercept<InterceptorMap[K]> | Promise<Intercept<InterceptorMap[K]>>,
    options?: InterceptorOptions,
  ): () => void
}

export type Extension = (api: ExtensionAPI) => void | Promise<void>

export function defineExtension(ext: Extension): Extension {
  return ext
}

export function defineTool<P>(tool: ToolDefinition<P>): ToolDefinition<P> {
  return tool
}
