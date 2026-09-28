import type { EventEnvelope, EventMap, Intercept, InterceptorMap, InterceptorOptions } from "./events.ts"
import type { RunCommandOptions, RunCommandResult } from "./process.ts"
import type { ToolDefinition } from "./tools.ts"
import type { StatusItem } from "./ui.ts"

export interface InterceptContext {
  sessionId: string
  signal: AbortSignal
}

export interface ExtensionAPI {
  readonly apiVersion: string
  /** Returns a function that removes this registration. */
  registerTool(tool: ToolDefinition): () => void
  /** Adds an item to the status bar. Replacing an existing id requires `override: true`. */
  registerStatusItem(item: StatusItem): () => void
  /** Asks frontends to redraw, e.g. after a status item's state changed. */
  requestRender(): void
  /**
   * Runs a command off the main thread (a slow spawn cannot freeze the UI), killing the
   * whole process tree on abort, timeout and exit.
   */
  runCommand(argv: string[], options: RunCommandOptions): Promise<RunCommandResult>
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
