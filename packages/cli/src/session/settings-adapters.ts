import type { Ai, ModelInfo, RetryOptions } from "@amira/ai"
import type { Settings, ToolDefinition } from "@amira/api"
import { type CompactionOptions, type ContextOptions, toolTraits } from "@amira/core"
import type { ActivePackages } from "@amira/packages"
import { UsageError } from "../args.ts"
import { withProviderHint } from "../provider-command.ts"

/** Settings `retry` as ai retry options (D52); `attempts` counts the retries after the first try. */
export function retryFromSettings(retry: Settings["retry"]): RetryOptions | undefined {
  if (!retry) return undefined
  const out: RetryOptions = {}
  if (retry.attempts !== undefined) out.retries = retry.attempts
  if (retry.baseDelayMs !== undefined) out.baseDelayMs = retry.baseDelayMs
  if (retry.maxDelayMs !== undefined) out.maxDelayMs = retry.maxDelayMs
  if (retry.firstContentTimeoutMs !== undefined) out.firstContentTimeoutMs = retry.firstContentTimeoutMs
  if (retry.idleTimeoutMs !== undefined) out.idleTimeoutMs = retry.idleTimeoutMs
  if (retry.nativeCompactionTimeoutMs !== undefined)
    out.nativeCompactionTimeoutMs = retry.nativeCompactionTimeoutMs
  return Object.keys(out).length ? out : undefined
}

/** Settings `compact` as agent options; its model is resolved like --model. */
export function compactionFromSettings(ai: Ai, compact: Settings["compact"]): CompactionOptions | undefined {
  if (!compact) return undefined
  const out: CompactionOptions = {}
  if (compact.threshold !== undefined) out.threshold = compact.threshold
  if (compact.model) out.model = resolveModel(ai, compact.model)
  if (compact.layout) out.layout = compact.layout
  return Object.keys(out).length ? out : undefined
}

/** Settings `context` as agent options. */
export function contextFromSettings(context: Settings["context"]): ContextOptions | undefined {
  if (!context) return undefined
  const out: ContextOptions = {}
  const o = context.outputs
  if (o?.saveAbove !== undefined) out.saveAbove = o.saveAbove
  if (o?.previewChars !== undefined)
    out.previewChars = Math.min(o.previewChars, o.saveAbove ?? o.previewChars)
  if (o?.quotaMB !== undefined) out.quotaBytes = o.quotaMB * 1024 * 1024
  if (context.dedupeReads !== undefined) out.dedupeReads = context.dedupeReads
  if (context.aging) out.aging = { ...context.aging }
  return Object.keys(out).length ? out : undefined
}

/** The tools to hide for a shell mode and an explicit list (D68, D70). */
export function toolsToDisable(
  shell: "auto" | "bash" | "powershell",
  explicit: string[],
  tools: readonly Pick<ToolDefinition, "name" | "traits">[] = [],
): string[] {
  const out = new Set(explicit)
  if (shell !== "auto") {
    for (const tool of tools) {
      const kind = toolTraits(tool)?.shell
      if (kind && kind !== shell) out.add(tool.name)
    }
  }
  return [...out]
}

export function resolveModel(ai: Ai, ref: string): ModelInfo {
  try {
    return ai.model(ref)
  } catch (err) {
    throw new UsageError(withProviderHint(err instanceof Error ? err.message : String(err), "startup"))
  }
}

/** With exactly one provider configured, the first model it lists ("provider/model"). */
export function onlyProviderModel(ai: Ai): string | undefined {
  const providers = ai.providers()
  const [only] = providers
  const first = only?.models?.find((m) => m.id)?.id
  return providers.length === 1 && only && first ? `${only.id}/${first}` : undefined
}

/** Package skill directories are searched after the ones from settings. */
export function withPackageSkills(settings: Settings, packages: ActivePackages | undefined): Settings {
  const dirs = packages?.packages.flatMap((p) => p.manifest.skills) ?? []
  if (!dirs.length) return settings
  return { ...settings, skills: { ...settings.skills, dirs: [...(settings.skills?.dirs ?? []), ...dirs] } }
}
