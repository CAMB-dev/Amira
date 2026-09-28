import { type Ai, createAi } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import {
  Agent,
  defaultSections,
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  renderPrompt,
  ToolRegistry,
} from "@amira/core"

export interface SessionOptions {
  model: string
  cwd: string
  extensions: string[]
  noBuiltins: boolean
  ai?: Ai
}

export interface Session {
  agent: Agent
  host: ExtensionHost
  /** Extension events emitted while loading, before any frontend subscribed. */
  startupEvents: AnyEvent[]
}

/**
 * Wires the ai layer, core registries, extensions and the agent together.
 * Extension failures are reported as extension.error events on the agent's bus.
 */
export async function createSession(opts: SessionOptions): Promise<Session> {
  const ai = opts.ai ?? createAi()
  const model = ai.model(opts.model)
  const bus = new EventBus()
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
    const mod: { default?: unknown } = await import("@amira/builtin-tools")
    if (typeof mod.default === "function") await host.load(mod.default as never, "builtin:tools")
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
