import { type Ai, createAi, type ModelInfo } from "@amira/ai"
import type { AnyEvent, Extension } from "@amira/api"
import {
  Agent,
  defaultSections,
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  renderPrompt,
  ToolRegistry,
} from "@amira/core"
import { UsageError } from "./args.ts"

export interface SessionOptions {
  model: string
  cwd: string
  extensions: string[]
  noBuiltins: boolean
  ai?: Ai
  /** Receives failures of event subscribers (extensions or frontends). The core itself never prints. */
  onSubscriberError?: (error: unknown, event: AnyEvent) => void
  /** Loads the bundled extensions; injectable for tests. */
  builtins?: () => Promise<{ source: string; extension: Extension }[]>
}

export interface Session {
  agent: Agent
  host: ExtensionHost
  /** Extension events emitted while loading, before any frontend subscribed. */
  startupEvents: AnyEvent[]
}

async function defaultBuiltins(): Promise<{ source: string; extension: Extension }[]> {
  const tools: { default?: unknown } = await import("@amira/builtin-tools")
  if (typeof tools.default !== "function") throw new Error("@amira/builtin-tools has no default export")
  return [{ source: "builtin:tools", extension: tools.default as Extension }]
}

/**
 * Wires the ai layer, core registries, extensions and the agent together.
 * Extension failures are reported as extension.error events on the agent's bus.
 */
export async function createSession(opts: SessionOptions): Promise<Session> {
  const ai = opts.ai ?? createAi()
  let model: ModelInfo
  try {
    model = ai.model(opts.model)
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err))
  }
  const bus = new EventBus(opts.onSubscriberError)
  const interceptors = new InterceptorRegistry({
    onError: (point, source, error) =>
      bus.emit("extension.error", { source, error: `${point}: ${error}` }, { sessionId: "host" }),
  })
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus, interceptors, tools })
  const startupEvents: AnyEvent[] = []
  const stopCapture = bus.subscribe((e) => void startupEvents.push(e), {
    types: ["extension.error", "extension.loaded"],
  })

  if (!opts.noBuiltins) {
    try {
      for (const b of await (opts.builtins ?? defaultBuiltins)()) await host.load(b.extension, b.source)
    } catch (err) {
      const error = `failed to load built-in extensions: ${err instanceof Error ? err.message : String(err)}`
      bus.emit("extension.error", { source: "builtin", error }, { sessionId: "host" })
    }
  }
  for (const file of opts.extensions) await host.loadFile(file)
  await bus.flush()
  stopCapture()

  const agent = new Agent({
    ai,
    model,
    cwd: opts.cwd,
    systemPrompt: renderPrompt(defaultSections({ cwd: opts.cwd })),
    bus,
    interceptors,
    tools,
  })
  return { agent, host, startupEvents }
}
