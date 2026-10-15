import type { ShellKind, ToolDefinition } from "@amira/api"
import type { InterceptOutcome, InterceptorRegistry } from "./interceptors.ts"
import { toolTraits } from "./tool-traits.ts"

type ShellTool = Pick<ToolDefinition, "name" | "traits" | "shellKind">

export interface ShellClassification {
  /** Present only when runtime resolution succeeded. */
  kind?: ShellKind
  kinds: readonly ShellKind[]
}

/** Capture capabilities before awaiting guards, preserving class resolvers' receivers. */
export function captureShellTool(tool: ShellTool): ShellTool {
  const traits = tool.traits
  return {
    name: tool.name,
    traits: traits ? { ...traits } : undefined,
    shellKind: tool.shellKind?.bind(tool),
  }
}

/** A changed monitor entry point needs new authorization, not a different execution dialect. */
export function shellEntryChanged(tool: ShellTool, captured: ShellTool): boolean {
  return tool.name === "monitor" && toolTraits(tool)?.shell !== toolTraits(captured)?.shell
}

/** Resolve once; bash and monitor can fall back across dialects, so unknown means both. */
export async function classifyShell(tool: ShellTool): Promise<ShellClassification | undefined> {
  const declared = toolTraits(tool)?.shell
  if (!declared && !tool.shellKind) return undefined
  if (tool.shellKind) {
    try {
      const kind = await tool.shellKind()
      if (kind === "bash" || kind === "powershell") return { kind, kinds: [kind] }
    } catch {}
  }
  const kinds: ShellKind[] =
    tool.name !== "bash" && tool.name !== "monitor" && declared ? [declared] : ["bash", "powershell"]
  return { kinds }
}

/** Monitor is another entry point for the session shell, not an escape from its named guards. */
export function shellGuardNames(
  tool: ShellTool,
  shell?: ShellClassification,
  entryShell?: ShellKind,
): readonly string[] {
  if (tool.name !== "monitor") return [tool.name]
  // Bash's Windows fallback still enters through bash. Keep that entry point's guards
  // as well as the actual dialect's guards; explicitly selected PowerShell has no alias.
  const names = [...(entryShell ? [entryShell] : []), ...(shell?.kinds ?? ["bash", "powershell"])]
  return [tool.name, ...new Set(names)]
}

/** All before-interceptor decisions share the same captured shell and final argument pipeline. */
export async function beforeShellCall(
  interceptors: InterceptorRegistry,
  names: readonly string[],
  call: { toolCallId: string; name: string; args: Record<string, unknown> },
  ctx: { sessionId: string; signal: AbortSignal },
): Promise<InterceptOutcome<typeof call>> {
  let args = call.args
  const ask: string[] = []
  for (const name of names) {
    const alias = call.name === "monitor" && name !== call.name
    // Shell guards must see the actual operation, including its persistence. Monitor-only
    // options stay with monitor guards, rather than leaking into bash's argument schema.
    const guardedArgs = alias ? { command: args.command, background: true } : args
    const gate = await interceptors.run("tool.call.before", { ...call, name, args: guardedArgs }, ctx)
    if (gate.blocked) return { ...gate, value: { ...call, args } }
    if (alias) {
      if (gate.value.args.background !== true) {
        return {
          blocked: true,
          reason: "A shell guard disallowed background execution; monitor requires it.",
          value: { ...call, args },
        }
      }
      args = { ...args, command: gate.value.args.command }
    } else args = gate.value.args
    if (gate.ask) ask.push(...gate.ask)
  }
  return { blocked: false, value: { ...call, args }, ...(ask.length ? { ask } : {}) }
}
