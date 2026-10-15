import path from "node:path"
import type { SessionControl, ShellMode, ShimmerEffect, TuiSettings } from "@amira/api"
import { DEFAULT_DISABLED_TOOLS, DEFAULT_SHELL } from "@amira/api"
import { type Agent, CommandHost, listSubagents } from "@amira/core"
import { createAdminControl } from "./control/admin.ts"
import type { ControlContext, ControlTrace } from "./control/context.ts"
import { createInfoControl } from "./control/info.ts"
import { createRewindControl } from "./control/rewind.ts"
import { createSessionsControl } from "./control/sessions.ts"
import { createToolControl } from "./control/tools.ts"
import { rememberingControl } from "./remember-choice.ts"
import type { Session } from "./session.ts"

/** Waiting for a committed handover must yield, and cancellation must detach its listener. */
function waitForTransition(tail: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let listening = true
    const cleanup = () => {
      if (listening) signal.removeEventListener("abort", abort)
      listening = false
    }
    const abort = () => {
      cleanup()
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    tail.then(() => {
      cleanup()
      resolve()
    })
  })
}

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
  rememberTheme(
    name: string,
    variant: NonNullable<TuiSettings["themeVariant"]>,
    shimmer?: ShimmerEffect,
  ): void
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
    const off = new Set([...(opts.disabled ?? [...DEFAULT_DISABLED_TOOLS]), ...turnedOff])
    for (const name of turnedOn) off.delete(name)
    tools.setDisabled(off)
    tools.setPolicy({ shell, enabled: turnedOn })
  }

  const agent = () => host.agent
  const directory = () => (agent().session ? path.dirname(agent().session!.file) : undefined)
  const idle = (what: string) => {
    const a = agent()
    if (!a.busy) return
    const running = a.turnId ? "a turn" : `a ${a.holdingFor ?? "compaction"}`
    throw new Error(`${running} is running; ${what} after it ends (or press esc to stop it)`)
  }
  let selection: { controller: AbortController; cleanup: () => void } | undefined
  let transitionTail: Promise<void> | undefined
  const select: ControlContext["select"] = async (callerSignal, run) => {
    selection?.cleanup()
    selection?.controller.abort(new Error("cancelled"))
    const controller = new AbortController()
    let listening = false
    const cleanup = () => {
      if (listening) callerSignal!.removeEventListener("abort", cancel)
      listening = false
    }
    const cancel = () => {
      cleanup()
      controller.abort(new Error("cancelled"))
    }
    const current = { controller, cleanup }
    selection = current
    if (callerSignal?.aborted) cancel()
    else if (callerSignal) {
      callerSignal.addEventListener("abort", cancel, { once: true })
      listening = true
    }
    try {
      controller.signal.throwIfAborted()
      // A committed winner owns the tree already, even while the host still shows its predecessor.
      // Only this queued selection is cancellable: never abort the committed winner's disposal.
      if (transitionTail) await waitForTransition(transitionTail, controller.signal)
      controller.signal.throwIfAborted()
      await run(controller.signal)
    } finally {
      cleanup()
      if (selection === current) selection = undefined
    }
  }
  const switchTo = async (
    rootSessionId: string,
    makeNext: (continueAfterAcquisition: (construct: () => Agent) => Agent) => Agent | Promise<Agent>,
    reason: "resume" | "clear" | "fork",
    signal: AbortSignal,
  ) => {
    const old = agent()
    let completeTransition: (() => void) | undefined
    const different = rootSessionId !== old.sessionId
    let handover: ReturnType<typeof session.host.backgroundJobs.handoverRoot> | undefined
    const made = makeNext((construct) => {
      // Acquisition may wait while RPC processes another switch or a notice starts a turn.
      // Reject before constructing: disposing an unused candidate would abort the shared tree.
      signal.throwIfAborted()
      if (selection?.controller.signal !== signal || agent() !== old) throw new Error("cancelled")
      if (different) idle("switch sessions")
      // A different target is constructed first, preserving old jobs if construction fails.
      // Rewinds hand over first so closing the old scope cannot close the replacement's.
      const other = different ? construct() : undefined
      old.cancelNoticeRetry()
      handover = session.host.backgroundJobs.handoverRoot(old.sessionId, rootSessionId)
      const next = other ?? construct()
      old.thinking.carryTo(next.thinking)
      next.fastMode = old.fastMode
      old.handoverBackgroundNotices(next)
      // Commit is synchronous with acquisition and notice handover. Later selections must wait
      // for this disposal, and neither they nor the original caller can cancel this winner.
      selection.cleanup()
      selection = undefined
      const tail = new Promise<void>((resolve) => {
        completeTransition = () => {
          if (transitionTail === tail) transitionTail = undefined
          resolve()
        }
      })
      transitionTail = tail
      return next
    })
    // Construction and all hand-over setup share the acquired claim's synchronous continuation.
    // Do not introduce a microtask gap for a synchronous claim's pending notice deliveries.
    const next = made instanceof Promise ? await made : made
    try {
      await handover
      await old.dispose("switch")
    } finally {
      try {
        host.switchTo(next)
        opts.announce?.(next, reason)
      } finally {
        completeTransition?.()
      }
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
    select,
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
    rememberTheme: (
      name: string,
      variant: NonNullable<TuiSettings["themeVariant"]>,
      ...shimmer: [ShimmerEffect?]
    ) => choices?.rememberTheme(name, variant, ...shimmer),
    flushChoices: () => choices?.flush() ?? Promise.resolve(),
  })
}
