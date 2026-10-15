import { type ToolContext, type ToolResult, textResult } from "@amira/api"
import { statOrNull } from "./files.ts"
import type { Shell } from "./shell.ts"

/** Validation shared by foreground commands, background jobs and monitors. */
export async function validateShellCommand(
  command: unknown,
  ctx: ToolContext,
): Promise<ToolResult | undefined> {
  if (typeof command !== "string" || !command.trim()) return textResult("command is required", true)
  if (command.includes("\0")) return textResult("command must not contain NUL characters", true)
  if (ctx.signal.aborted) return textResult("Aborted before the command started", true)
  if (!(await statOrNull(ctx.cwd))?.isDirectory()) {
    return textResult(`Working directory does not exist: ${ctx.cwd}`, true)
  }
  return undefined
}

/** Never execute a different dialect from the one whose guards authorized the command. */
export async function resolveExecutionShell(resolve: () => Promise<Shell>, ctx: ToolContext): Promise<Shell> {
  const shell = await resolve()
  if (ctx.signal.aborted) throw new Error("Aborted before the command started")
  if (ctx.shellKind && shell.kind !== ctx.shellKind) {
    throw new Error("The shell changed after authorization; retry the command.")
  }
  return shell
}
