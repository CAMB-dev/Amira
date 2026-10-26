import { AGENT_STATUS_BADGES, agentStatusState, type SubagentStatus, type ToolPresenter } from "@amira/api"
import { type AgentParams, taskList } from "./tools.ts"

/** Each report's heading ends in how its sub-agent ended: "## title · role · id · done (…)". */
function reportStates(text: string): SubagentStatus[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .flatMap((l) => {
      const status = / · (done|error|aborted)(?: \(|$)/.exec(l)?.[1]
      return status ? [status as SubagentStatus] : []
    })
}

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
    const states = reportStates(call.text)
    if (reports > 1 && states.length === reports) {
      // How they ended, by state, as the tree under the call words them: "2 done · 2 failed".
      const labels = states.map((s) => AGENT_STATUS_BADGES[agentStatusState({ status: s })].label)
      return [...new Set(labels)]
        .map((label) => `${labels.filter((l) => l === label).length} ${label}`)
        .join(" · ")
    }
    if (reports > 1) return `${reports} reports`
    return call.text.split("\n")[0]?.replace(/^#+\s*/, "") || undefined
  },
  /** One of several sub-agents failing or stopping is not a success of the whole call. */
  outcome(call) {
    if (call.result.isError) return undefined
    return reportStates(call.text).some((s) => s !== "done") ? "failed" : undefined
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
