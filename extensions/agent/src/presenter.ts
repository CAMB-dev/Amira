import type { ToolPresenter } from "@amira/api"
import { type AgentParams, taskList } from "./tools.ts"

/**
 * Shows an agent call by how many sub-agents it starts; frontends show each one under the
 * call (title, role, time, tokens, what it does), so the result line only sums them up.
 */
export const agentPresenter: ToolPresenter<AgentParams> = {
  summary(args) {
    const n = taskList(args).length
    return `· ${n} sub-agent${n === 1 ? "" : "s"}${args.background ? ` · background` : ""}`
  },
  result(call) {
    if (call.result.isError) return undefined
    if (call.text.startsWith("Started in the background")) return "started in the background"
    const reports = call.text.split("\n").filter((l) => l.startsWith("## ")).length
    if (reports > 1) return `${reports} reports`
    return call.text.split("\n")[0]?.replace(/^#+\s*/, "") || undefined
  },
  /** All of the reports, at the full level: each one's heading as a heading, not as "## ". */
  body(call, { detail }) {
    if (detail !== "full" || call.result.isError) return []
    return call.text
      .split("\n")
      .map((text) =>
        text.startsWith("## ") ? { kind: "accent", text: text.slice(3) } : { kind: "text", text },
      )
  },
}
