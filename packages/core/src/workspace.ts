import type { WorkspaceFacts, WorkspaceProvider } from "@amira/api"
import type { EventBus } from "./event-bus.ts"

interface Registration {
  provider: WorkspaceProvider
  source: string
  reportError(error: string): void
}

interface ActiveWorkspace {
  sessionId: string
  cwd: string
  abort: AbortController
  timer?: ReturnType<typeof setTimeout>
  checked: boolean
  checkedAt: number
  stamp?: string
  emitted?: string
  checking: boolean
  again?: "full" | "dirty"
  wrote: boolean
}

export interface WorkspaceOptions {
  initialDelayMs?: number
  staleMs?: number
}

const hosts = new WeakMap<EventBus, WorkspaceTracker>()

export function workspaceFor(bus: EventBus): WorkspaceTracker {
  let host = hosts.get(bus)
  if (!host) {
    host = new WorkspaceTracker(bus)
    hosts.set(bus, host)
  }
  return host
}

/** Provider-neutral scheduling and event ownership for the active top-level session. */
export class WorkspaceTracker {
  #registration?: Registration
  #active?: ActiveWorkspace
  #options: WorkspaceOptions = {}

  constructor(private readonly bus: EventBus) {
    bus.subscribe(
      (e) => {
        if (e.type === "session.start" && e.parentSessionId === undefined) {
          this.start(e.sessionId, e.data.cwd)
          return
        }
        const active = this.#active
        if (!active) return
        if (e.type === "session.end" && e.sessionId === active.sessionId) {
          this.#stop()
          return
        }
        if (e.sessionId !== active.sessionId && e.parentSessionId === undefined) return
        if (e.type === "tool.execute.end") {
          // Unknown tools and bubbled child tools are conservative unless explicitly no-write.
          if (e.data.traits?.writesFiles !== false) active.wrote = true
        } else if (e.type === "turn.end" && (active.checked || active.checking) && this.#registration) {
          const stamp = this.#stamp(this.#registration, active.cwd)
          if (stamp === undefined || stamp !== active.stamp) void this.#check(active, "full")
          else if (active.wrote || Date.now() - active.checkedAt >= (this.#options.staleMs ?? 60_000))
            void this.#check(active, "dirty")
        }
      },
      { types: ["session.start", "session.end", "turn.end", "tool.execute.end"] },
    )
  }

  register(
    provider: WorkspaceProvider,
    source: string,
    reportError: Registration["reportError"],
  ): () => void {
    if (this.#registration)
      throw new Error(`Workspace provider is already registered by ${this.#registration.source}`)
    const registration = { provider, source, reportError }
    this.#registration = registration
    this.#restart()
    return () => {
      if (this.#registration !== registration) return
      this.#registration = undefined
      this.#restart()
    }
  }

  start(sessionId: string, cwd: string, options: WorkspaceOptions = {}): () => void {
    this.#stop()
    this.#options = options
    const active: ActiveWorkspace = {
      sessionId,
      cwd,
      abort: new AbortController(),
      checked: false,
      checkedAt: 0,
      checking: false,
      wrote: false,
    }
    this.#active = active
    if (this.#registration)
      active.timer = setTimeout(() => void this.#check(active, "full"), options.initialDelayMs ?? 500)
    return () => {
      if (this.#active === active) this.#stop()
    }
  }

  #stop() {
    this.#active?.abort.abort()
    clearTimeout(this.#active?.timer)
    this.#active = undefined
  }

  #restart() {
    const active = this.#active
    if (active) {
      this.start(active.sessionId, active.cwd, this.#options)
      this.#active!.emitted = active.emitted
    }
  }

  #stamp(registration: Registration, cwd: string): string | undefined {
    try {
      return registration.provider.stamp?.(cwd)
    } catch (error) {
      registration.reportError(`workspace stamp failed: ${String(error)}`)
      return undefined
    }
  }

  async #check(active: ActiveWorkspace, kind: "full" | "dirty"): Promise<void> {
    const registration = this.#registration
    if (!registration || active.abort.signal.aborted) return
    if (active.checking) {
      active.again = active.again === "full" || kind === "full" ? "full" : "dirty"
      return
    }
    active.checking = true
    active.wrote = false
    try {
      const facts = await registration.provider.probe(active.cwd, active.abort.signal, kind)
      if (active.abort.signal.aborted || this.#active !== active || this.#registration !== registration)
        return
      active.checked = true
      active.checkedAt = Date.now()
      active.stamp = this.#stamp(registration, active.cwd)
      if (!facts) return
      if (facts.cwd !== active.cwd) throw new Error("workspace provider returned facts for a different cwd")
      // Copy only payload fields: providers cannot supply or override host event metadata.
      const data: WorkspaceFacts = {
        cwd: active.cwd,
        ...(facts.repoRoot !== undefined ? { repoRoot: facts.repoRoot } : {}),
        ...(facts.branch !== undefined ? { branch: facts.branch } : {}),
        ...(facts.head !== undefined ? { head: facts.head } : {}),
        ...(facts.isWorktree !== undefined ? { isWorktree: facts.isWorktree } : {}),
        ...(facts.dirty !== undefined ? { dirty: facts.dirty } : {}),
      }
      const signature = JSON.stringify(data)
      if (signature === active.emitted) return
      active.emitted = signature
      this.bus.emit("workspace.changed", data, { sessionId: active.sessionId })
    } catch (error) {
      if (!active.abort.signal.aborted) {
        active.checked = true
        active.checkedAt = Date.now()
        registration.reportError(`workspace probe failed: ${String(error)}`)
      }
    } finally {
      active.checking = false
      const next = active.again
      active.again = undefined
      if (next && !active.abort.signal.aborted) void this.#check(active, next)
    }
  }
}
