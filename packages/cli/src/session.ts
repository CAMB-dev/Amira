import { type Ai, createAi } from "@amira/ai"
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
  /** Called for extension load failures. */
  onExtensionError?: (source: string, error: string) => void
}

/** Wires the ai layer, core registries, extensions and the agent together. */
export async function createSession(opts: SessionOptions): Promise<Agent> {
  const ai = opts.ai ?? createAi()
  const model = ai.model(opts.model)
  const bus = new EventBus()
  const interceptors = new InterceptorRegistry({
    onError: (point, source, error) =>
      bus.emit("extension.error", { source, error: `${point}: ${error}` }, { sessionId: "host" }),
  })
  const tools = new ToolRegistry()
  const onError = (source: string, error: string) => {
    opts.onExtensionError?.(source, error)
    bus.emit("extension.error", { source, error }, { sessionId: "host" })
  }
  const host = new ExtensionHost({ bus, interceptors, tools, onError })

  if (!opts.noBuiltins) {
    const mod: { default?: unknown } = await import("@amira/builtin-tools")
    if (typeof mod.default === "function") await host.load(mod.default as never, "builtin:tools")
  }
  for (const file of opts.extensions) await host.loadFile(file)

  return new Agent({
    ai,
    model,
    cwd: opts.cwd,
    systemPrompt: renderPrompt(defaultSections({ cwd: opts.cwd })),
    bus,
    interceptors,
    tools,
  })
}
