import type { ToolResult } from "@amira/api"
import type { Theme } from "@amira/tui-kit"

/** One-line summary of tool arguments, e.g. `read src/index.ts` or `bash bun test`. */
export function summarizeArgs(args: Record<string, unknown>, max = 80): string {
  const s = Object.values(args)
    .filter((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .map(String)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function resultText(result: ToolResult): string {
  return result.content
    .map((b) => (b.type === "text" ? b.text : `[image ${b.mimeType}]`))
    .join("\n")
    .trim()
}

/** The committed lines for a finished tool call: a header and a one-line result preview. */
export function toolLines(
  theme: Theme,
  name: string,
  args: Record<string, unknown>,
  result: ToolResult,
  durationMs: number,
): string[] {
  const failed = result.isError === true
  const bullet = failed ? theme.error("●") : theme.success("●")
  const summary = summarizeArgs(args)
  const head = `${bullet} ${theme.accent(name)}${summary ? ` ${summary}` : ""}`
  const text = resultText(result)
  const lines = text ? text.split("\n") : []
  const first = (lines[0] ?? "(no output)").slice(0, 200)
  const more = lines.length > 1 ? ` (+${lines.length - 1} lines)` : ""
  const time = durationMs >= 1000 ? ` · ${(durationMs / 1000).toFixed(1)}s` : ""
  const preview = failed ? theme.error(first) : theme.muted(first)
  return [head, `  ${theme.muted("⎿")} ${preview}${theme.muted(more + time)}`]
}

/** Committed lines for the user's message. */
export function userLines(theme: Theme, text: string): string[] {
  return text.split("\n").map((l, i) => `${theme.accent(i === 0 ? "›" : " ")} ${l}`)
}
