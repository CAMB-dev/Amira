import path from "node:path"
import type { SessionControl, ShellMode } from "@amira/api"
import { DEFAULT_DISABLED_TOOLS, DEFAULT_SHELL } from "@amira/api"
import { type Agent, CommandHost, listSubagents } from "@amira/core"
import { createAdminControl } from "./control/admin.ts"
import type { ControlContext, ControlTrace } from "./control/context.ts"
import { createInfoControl } from "./control/info.ts"
import { createRewindControl } from "./control/rewind.ts"
import { createSessionsControl } from "./control/sessions.ts"
import { createToolControl } from "./control/tools.ts"
import { rememberingControl } from "./remember-choice.ts"
import { toolsToDisable } from "./session/settings-adapters.ts"
import type { Session } from "./session.ts"

export interface ControlOptions {
  session: Session
  /** The process-owned recorder, for fresh snapshots and deletion coordination. */
  trace?: ControlTrace
  cwd: string
  /** Remember user selections only on the interactive frontend, never extension controls. */
  interactive?: boolean
  /** Shell mode the session starts with (D68). See DEFAULT_SHELL. */
  shell?: ShellMode
  /** Tools settings or flags disabled explicitly (tools.disabled, --disable-tools). */
  disabled?: string[]
  /** Amira's user directory, for /provider add. Default: $AMIRA_HOME or ~/.amira. */
  home?: string
  platform?: string
  /** The user's command aliases (settings commandAliases). */
  aliases?: Record<string, string>
  /** Announces a session the commands switched to, e.g. agent.start() plus git tracking. */
  announce?: (agent: Agent, reason: "resume" | "clear" | "fork") => void
}

/**
 * The session control handed to slash commands, and the CommandHost frontends use. It owns
 * which agent is active: /clear and /resume make new agents on the same bus and registries.
 */
export function createCommandHost(opts: ControlOptions): CommandHost & {
  rememberTheme(name: string): void
  flushChoices(): Promise<void>
} {
  const { session, cwd } = opts
  const { ai } = session
  const tools = session.agent.tools
  const platform = opts.platform ?? process.platform
  let shell: ShellMode = opts.shell ?? DEFAULT_SHELL
  // Per-session choices from /tools; they win over settings and the shell mode.
  const turnedOff = new Set<string>()
  const turnedOn = new Set<string>()
  const applyDisabled = () => {
    const off = new Set([
      ...toolsToDisable(
        shell,
        opts.disabled ?? [...DEFAULT_DISABLED_TOOLS],
        tools.list().map(({ tool }) => tool),
      ),
      ...turnedOff,
    ])
    for (const name of turnedOn) off.delete(name)
    tools.setDisabled(off)
  }

  const agent = () => host.agent
  const directory = () => (agent().session ? path.dirname(agent().session!.file) : undefined)
  const idle = (what: string) => {
    const a = agent()
    if (!a.busy) return
    const running = a.turnId ? "a turn" : `a ${a.holdingFor ?? "compaction"}`
    throw new Error(`${running} is running; ${what} after it ends (or press Esc to stop it)`)
  }
  const switchTo = async (
    rootSessionId: string,
    makeNext: () => Agent,
    reason: "resume" | "clear" | "fork",
  ) => {
    // Nobody reads the old conversation any more: no resend of its held notices.
    const old = agent()
    old.cancelNoticeRetry()
    // Another session is opened first: if it cannot be (another process holds it), this one
    // keeps its jobs. The same session (a rewind) is reopened after the hand-over, which would
    // otherwise close the new agent's job scope too.
    const other = rootSessionId !== old.sessionId ? makeNext() : undefined
    // Top-level jobs belong to the active conversation, not to the Agent object that happened to
    // start them. Sub-agent jobs are still stopped as their old tree is handed over. The
    // re-rooting and the notice hand-over happen before anything awaits, so a job that ends
    // meanwhile reports to the new session.
    const handover = session.host.backgroundJobs.handoverRoot(old.sessionId, rootSessionId)
    const next = other ?? makeNext()
    // Like the current model, the /thinking choice follows the user to the next conversation.
    old.thinking.carryTo(next.thinking)
    old.handoverBackgroundNotices(next)
    try {
      await handover
      await old.dispose("switch")
    } finally {
      host.switchTo(next)
      opts.announce?.(next, reason)
    }
  }
  const rewindEntry = (index: number) => {
    const a = agent()
    const store = a.session
    if (!store) throw new Error("this session is not stored, so it cannot be rewound")
    const message = Number.isInteger(index) ? a.messages[index] : undefined
    if (message?.role !== "user")
      throw new Error(`message ${index} is not a user message of this conversation`)
    const id = a.entryId(message)
    const entry = id ? store.get(id) : undefined
    if (entry?.type !== "message") {
      throw new Error("that message was summarized by a compaction; only later ones can be rewound to")
    }
    return { a, store, entry }
  }
  const idleFiles = () => {
    if (agent().fileRewind?.busy) throw new Error("file tools are still running; wait for them to finish")
    if (
      listSubagents(agent(), session.tree).some((e) => ["running", "queued", "idle"].includes(e.info.status))
    ) {
      throw new Error("stop this session's active sub-agents before rewinding or pruning file history")
    }
  }

  const context: ControlContext = {
    session,
    trace: opts.trace ?? session.traceRecorder,
    cwd,
    ai,
    tools,
    platform,
    ...(opts.home ? { home: opts.home } : {}),
    agent,
    directory,
    idle,
    switchTo,
    rewindEntry,
    idleFiles,
    applyDisabled,
    shell: {
      get: () => shell,
      set: (mode) => {
        shell = mode
      },
    },
    turnedOff,
    turnedOn,
  }

  const control: SessionControl = {
    ...createInfoControl(context),
    ...createSessionsControl(context),
    ...createRewindControl(context),
    ...createToolControl(context),
    ...createAdminControl(context),
  }

  session.host.setSessionControl(control, agent)
  const choices = opts.interactive ? rememberingControl(control, agent, cwd, opts.home) : undefined
  const userControl = choices?.control ?? control

  const host = new CommandHost({
    registry: session.host.commands,
    skills: session.host.skills,
    inputs: session.host.inputs,
    bus: session.agent.bus,
    ui: session.host.ui,
    control: userControl,
    contextControl: (source) =>
      source === "builtin:commands" || source === "builtin:tui" ? userControl : control,
    agent: session.agent,
    ...(opts.aliases ? { aliases: opts.aliases } : {}),
  })
  return Object.assign(host, {
    rememberTheme: (name: string) => choices?.rememberTheme(name),
    flushChoices: () => choices?.flush() ?? Promise.resolve(),
  })
}
