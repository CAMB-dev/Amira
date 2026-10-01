import type { ApprovalPermission, ToolLine, ToolPresenter } from "@amira/api"
import type { AgentTree, Approver, Asker, UiRequests } from "@amira/core"

export interface ApproverOptions {
  /** Where tools' presenters are, to show what a call would do (a command, a diff). */
  presenters?: { get(toolName: string): ToolPresenter<any, any> | undefined }
  /** Tells the user something, e.g. that a call is allowed for the rest of the session. */
  notify?: (text: string) => void
  /** The agent tree, to say which sub-agent a question comes from. */
  tree?: Pick<AgentTree, "subagent">
}

/** Which mode or rule made the permission policy ask, for the dialog. */
function permissionLine(p: ApprovalPermission): string {
  if (p.rule) {
    return `Permission rule ${JSON.stringify(p.rule.command)} says ${p.rule.decision} (${p.rule.scope} settings, ${p.rule.file}).`
  }
  if (p.cause === "protected")
    return 'Protected file: changes to it ask in every mode ("Don\'t ask again" lifts that for this session).'
  if (p.cause === "complex")
    return `Permission mode "${p.mode}": the command cannot be checked against the rules word by word.`
  return `Permission mode "${p.mode}".`
}

/**
 * The top-level session's approvals go to the user (D13). Print mode cannot ask, so there a
 * call an interceptor asked about is denied. Dismissing the question (Esc) denies the call
 * and interrupts the turn.
 */
export function userApprover(ui: UiRequests, opts: ApproverOptions = {}): Approver {
  /** Calls the user said not to ask about again: a tool with the reason it was asked about. */
  const allowed = new Set<string>()
  return async (request, signal) => {
    const key = JSON.stringify([request.name, request.reason])
    if (allowed.has(key)) return { approved: true, by: "rule" }
    if (ui.unavailable) return { approved: false, reason: `nobody can approve it (${ui.unavailable})` }
    const preview = approvalPreview(request.args, opts.presenters?.get(request.name))
    // "Don't ask again" covers this tool asked about for this reason; the message says so.
    const scope = `"Don't ask again" covers ${request.name} asked about for: ${request.reason}`
    const sub = opts.tree?.subagent(request.sessionId)
    const head = [
      ...(sub ? [`Asked by the sub-agent "${sub.info.title}" (${sub.info.id}).`] : []),
      ...(request.permission ? [permissionLine(request.permission)] : []),
      request.reason,
    ].join("\n")
    const message = preview ? `${head}\n${scope}` : `${head}\n${rawArgs(request.args)}\n${scope}`
    const answer = await ui.ask(
      {
        kind: "confirm",
        title: `Allow ${request.name}?`,
        message,
        always: true,
        other: true,
        ...(preview ? { preview } : {}),
      },
      { signal, source: "approval" },
    )
    if (answer === "always") {
      allowed.add(key)
      opts.notify?.(
        `${request.name} is allowed without asking for the rest of this session (${request.reason}).`,
      )
    }
    if (answer === true || answer === "always") return { approved: true, by: "user" }
    if (typeof answer === "object") return { approved: false, reason: `the user said no: ${answer.other}` }
    if (answer === false) return { approved: false, reason: "the user said no" }
    // Cancelled: by the turn's interrupt, or by the user dismissing the question.
    if (signal.aborted) return { approved: false, reason: "the turn was interrupted" }
    return {
      approved: false,
      reason: "the user dismissed the question and stopped the turn",
      interrupt: true,
    }
  }
}

/** A call's arguments as JSON, cut short. */
function rawArgs(args: Record<string, unknown>): string {
  const json = JSON.stringify(args)
  return json.length > 300 ? `${json.slice(0, 299)}…` : json
}

/**
 * What an asked-about call would do, as its presenter shows it: the lines of its body worked
 * out from the arguments alone (edit and write show their diff), else its summary as a line
 * of code (bash shows the command). Undefined when the tool has no presenter for it.
 */
export function approvalPreview(
  args: Record<string, unknown>,
  presenter: ToolPresenter<any, any> | undefined,
): ToolLine[] | undefined {
  if (!presenter) return undefined
  try {
    const view = { args, result: { content: [] }, text: "" }
    const body = presenter.body?.(view, { detail: "full", width: 100 }) ?? []
    const summary = presenter.summary?.(args)?.trim()
    if (body.length) return summary ? [{ kind: "muted", text: summary }, ...body] : body
    // A command is shown whole: the summary has its first line only.
    const command = typeof args.command === "string" && args.command.trim() ? args.command : summary
    if (command) return command.split("\n").map((text) => ({ kind: "code", text }))
  } catch {
    // A presenter that cannot show it leaves the raw arguments.
  }
  return undefined
}

/**
 * The top-level session's questions go to the user; a sub-agent's reach here when
 * its commander passes them on, marked as such. Print mode says nobody can answer.
 */
export function userAsker(ui: UiRequests, tree?: AgentTree): Asker {
  return async (request, signal) => {
    if (ui.unavailable) return { unavailable: ui.unavailable }
    const source = tree?.subagent(request.sessionId) ? "sub-agent" : undefined
    const answers = await ui.api(source).ask(request.questions, { signal })
    return answers ? { answers } : { declined: true }
  }
}
