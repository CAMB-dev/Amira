import { existsSync, rmSync } from "node:fs"
import path from "node:path"
import type { Ai, Message } from "@amira/ai"
import type {
  ConversationRuntime,
  ConversationSpec,
  OwnedConversation,
  OwnedConversations,
  SpawnGroupOptions,
} from "@amira/api"
import { Agent } from "./agent.ts"
import { checkAskAnswers } from "./ask-answers.ts"
import { EventBus } from "./event-bus.ts"
import { amiraHome } from "./home.ts"
import { ConversationEvents } from "./owned-conversations-events.ts"
import { ConversationOpenings } from "./owned-conversations-openings.ts"
import { type InactiveConversationState, restoredConversationState } from "./owned-conversations-state.ts"
import {
  claimOwned,
  ownedDirectory,
  ownedId,
  publishOwned,
  readOwned,
  type SavedConversation,
  validateSpec,
} from "./owned-conversations-storage.ts"
import { approveWithHost } from "./subagents/host-approval.ts"
import { AgentTree } from "./subagents.ts"
import { ToolRegistry } from "./tool-registry.ts"
import { TraceRecorder } from "./trace.ts"

export interface OwnedConversationManagerOptions {
  ai: Ai
  tools: ToolRegistry
  /** Current main configuration is captured on open, never used to retarget a live handle. */
  agent: () => Agent
  home?: string
  tree: AgentTree
  /** Initialization/reload execution barrier; opening remains inert and available. */
  canExecute?: () => boolean
}

/** Host-owned durable conversations, independent of the replacing main-session lifecycle. */
export class OwnedConversationManager {
  #opts: OwnedConversationManagerOptions
  #home: string
  #handles = new Map<string, { owner: string; handle: Handle }>()
  #owners = new Map<string, { released: boolean; cleanup: (() => void)[] }>()
  #closed = false
  #openings = new ConversationOpenings()

  constructor(options: OwnedConversationManagerOptions) {
    this.#opts = options
    this.#home = path.resolve(options.home ?? amiraHome())
  }

  forOwner(owner: string, signal?: AbortSignal): OwnedConversations {
    if (!owner || typeof owner !== "string") throw new Error("conversation owner is required")
    if (this.#closed) throw new Error("owned conversation manager has been released")
    const scope = this.#owners.get(owner) ?? { released: false, cleanup: [] }
    this.#owners.set(owner, scope)
    const check = () => {
      signal?.throwIfAborted()
      if (this.#closed || scope.released) throw new Error("owned conversation owner has been released")
    }
    const abort = () => void this.releaseOwner(owner).catch(() => {})
    if (signal && !signal.aborted) {
      signal.addEventListener("abort", abort, { once: true })
      scope.cleanup.push(() => signal.removeEventListener("abort", abort))
    }
    return {
      openOrCreate: async (input, runtime) => {
        check()
        const spec = validateSpec(input)
        const id = ownedId(owner, spec.key)
        const file = path.join(ownedDirectory(this.#home, owner), `${id}.spec.json`)
        if (existsSync(file) || existsSync(file.replace(/\.spec\.json$/, ".jsonl"))) {
          const saved = readOwned(this.#home, owner, id)
          if (
            JSON.stringify(validateSpec({ ...spec, model: spec.model ?? saved.spec.model })) !==
            JSON.stringify(saved.spec)
          ) {
            throw new Error("conversation spec differs from its persisted identity or policy")
          }
          return this.#open(saved, runtime)
        }
        const main = this.#opts.agent()
        const saved: SavedConversation = {
          v: 1,
          owner,
          id,
          spec: { ...spec, model: spec.model ?? `${main.model.provider}/${main.model.id}` },
          runtimeTools: (runtime.extraTools ?? []).map((tool) => tool.name),
        }
        return this.#open(saved, runtime, true)
      },
      open: async (id, runtime) => {
        check()
        return this.#open(readOwned(this.#home, owner, id), runtime)
      },
    }
  }

  async #open(
    saved: SavedConversation,
    runtime: ConversationRuntime,
    create = false,
  ): Promise<OwnedConversation> {
    const { owner, id, spec } = saved
    validateRuntime(saved, runtime)
    const file = path.join(ownedDirectory(this.#home, owner), `${id}.jsonl`)
    const existing = this.#handles.get(file)
    if (existing) {
      if (existing.handle.isReleased())
        throw new Error("owned conversation is in use while its owner is unloading")
      return existing.handle
    }
    const main = this.#opts.agent()
    const model = this.#opts.ai.model(spec.model)
    const opening = this.#openings.begin(owner)
    try {
      const lease = await claimOwned(this.#home, saved, create, { signal: opening.signal })
      let tree: AgentTree | undefined
      try {
        opening.signal.throwIfAborted()
        if (create) {
          lease.store.appendDisplay({ type: "display", text: `Conversation: ${spec.name}`, level: "info" })
          publishOwned(this.#home, saved)
        } else if (!existsSync(path.join(ownedDirectory(this.#home, owner), `${id}.spec.json`))) {
          publishOwned(this.#home, saved)
        }
        tree = new AgentTree({
          ai: this.#opts.ai,
          shared: this.#opts.tree,
          restricted: true,
          sections: () => [],
        })
        const initialState = restoredConversationState(lease.store)
        const agent = new Agent({
          ai: this.#opts.ai,
          model,
          cwd: spec.cwd,
          systemPrompt: spec.systemPrompt,
          session: lease.store,
          ownedConversation: owner,
          bus: new EventBus(),
          interceptors: main.interceptors,
          approve: (request, signal) => approveWithHost(main, request, signal),
          tools: ToolRegistry.view(this.#opts.tools, () => true, runtime.extraTools),
          callableTools: new Set(spec.callableTools.filter((name) => main.callableTools?.has(name) ?? true)),
          providerSettings: main.providerSettings,
          permissions: main.permissions,
          compaction: main.compaction,
          context: main.context,
          tree,
          thinking: main.thinking.for(model),
          fileRewindSettings: main.fileRewindSettings,
          backgroundJobs: main.backgroundJobsHost,
          maxParallelTools: main.maxParallelTools,
          // Background results wait for the owner's next explicit send, never wake/retry themselves.
          onIdleNotice: () => {},
          noticeRetryMs: [],
          ask: (request, signal) => directAsk(runtime, request.questions, request.sessionId, signal),
        })
        const handle = new Handle(
          spec,
          agent,
          () => {
            lease.release()
            this.#handles.delete(file)
          },
          initialState,
          this.#opts.canExecute ?? (() => true),
        )
        this.#handles.set(file, { owner, handle })
        agent.start(create ? "startup" : "resume", { sessionFile: file })
        return handle
      } catch (error) {
        tree?.releaseScope()
        try {
          if (create) {
            rmSync(path.join(ownedDirectory(this.#home, owner), `${id}.spec.json`), { force: true })
            rmSync(file, { force: true })
          }
        } finally {
          lease.release()
        }
        throw error
      }
    } finally {
      opening.finish()
    }
  }

  async releaseOwner(owner: string): Promise<void> {
    const scope = this.#owners.get(owner)
    if (scope) {
      scope.released = true
      for (const cleanup of scope.cleanup) cleanup()
      this.#owners.delete(owner)
    }
    const pending = this.#openings.stop(owner)
    await Promise.all([
      pending,
      ...[...this.#handles.values()]
        .filter((entry) => entry.owner === owner)
        .map((entry) => entry.handle.release()),
    ])
  }

  async drain(): Promise<void> {
    this.#closed = true
    await this.#openings.stop()
    await Promise.all([...this.#owners.keys()].map((owner) => this.releaseOwner(owner)))
    await Promise.all([...this.#handles.values()].map((entry) => entry.handle.release()))
  }
}

function validateRuntime(saved: SavedConversation, runtime: ConversationRuntime): void {
  if (
    !runtime ||
    typeof runtime.askUser !== "function" ||
    (runtime.extraTools !== undefined && !Array.isArray(runtime.extraTools))
  ) {
    throw new Error("conversation runtime requires a direct askUser callback")
  }
  const names = new Set<string>()
  for (const tool of runtime.extraTools ?? []) {
    if (
      !tool ||
      typeof tool.name !== "string" ||
      !saved.spec.callableTools.includes(tool.name) ||
      names.has(tool.name) ||
      typeof tool.execute !== "function" ||
      typeof tool.description !== "string" ||
      !tool.parameters ||
      typeof tool.parameters !== "object" ||
      Array.isArray(tool.parameters) ||
      (tool.shellKind !== undefined && typeof tool.shellKind !== "function") ||
      !validTraits(tool)
    ) {
      throw new Error("invalid or disallowed conversation runtime extra tool")
    }
    names.add(tool.name)
  }
  if (saved.runtimeTools.some((name) => !names.has(name)))
    throw new Error("required conversation runtime tools are missing")
}

function validTraits(tool: import("@amira/api").ToolDefinition): boolean {
  const traits = tool.traits
  if (traits === undefined) return true
  if (!traits || typeof traits !== "object" || Array.isArray(traits)) return false
  for (const [name, value] of Object.entries(traits)) {
    if (name === "writesFiles") {
      if (typeof value !== "boolean" && value !== "paths") return false
      if (value === "paths" && typeof tool.getWrittenPaths !== "function") return false
    } else if (name === "shell") {
      if (value !== "bash" && value !== "powershell") return false
    } else if (name === "editor") {
      if (value !== "edit" && value !== "apply_patch") return false
    } else if (
      !["readOnly", "usesMutationHook", "artifactReader", "toolSearch", "interactive"].includes(name) ||
      typeof value !== "boolean"
    )
      return false
  }
  return true
}

function directAsk(
  runtime: ConversationRuntime,
  questions: Parameters<ConversationRuntime["askUser"]>[0],
  sessionId: string,
  signal: AbortSignal,
): Promise<import("@amira/api").AskOutcome> {
  if (signal.aborted) return Promise.resolve({ declined: true })
  return new Promise((resolve, reject) => {
    const abort = () => resolve({ declined: true })
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve()
      .then(() => (signal.aborted ? undefined : runtime.askUser(questions, { sessionId, signal })))
      .then((answers) => {
        if (signal.aborted || answers === undefined) return resolve({ declined: true })
        const error = checkAskAnswers(questions, answers)
        if (error) return reject(new Error(`invalid owner answer: ${error}`))
        resolve({ answers })
      }, reject)
      .finally(() => signal.removeEventListener("abort", abort))
  })
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

class Handle implements OwnedConversation {
  readonly id: string
  readonly key: string
  readonly name: string
  readonly cwd: string
  readonly data: OwnedConversation["data"]
  readonly events: ConversationEvents
  #agent: Agent
  #state: InactiveConversationState
  #canExecute: () => boolean
  #stopping: Promise<void> | undefined
  #running: Promise<void> | undefined
  #abort: AbortController | undefined
  #trace: TraceRecorder
  #released = false
  #release: Promise<void> | undefined
  #onRelease: () => void

  constructor(
    spec: ConversationSpec,
    agent: Agent,
    onRelease: () => void,
    state: InactiveConversationState,
    canExecute: () => boolean,
  ) {
    this.#state = state
    this.#canExecute = canExecute
    this.id = agent.sessionId
    this.key = spec.key
    this.name = spec.name
    this.cwd = spec.cwd
    this.data = {
      append: (key, value) => {
        this.#check()
        agent.data.append(key, value)
      },
      read: (key) => {
        this.#check()
        return agent.data.read(key)
      },
    }
    this.events = new ConversationEvents(agent.bus)
    this.#trace = new TraceRecorder(agent.bus)
    this.#trace.register(agent.sessionId, agent.session!.file)
    this.#agent = agent
    this.#onRelease = onRelease
  }

  isReleased(): boolean {
    return this.#released
  }

  #check(): void {
    if (this.#released) throw new Error("owned conversation has been released")
  }

  history(): readonly Message[] {
    this.#check()
    return freeze(
      structuredClone(
        this.#agent.session!.branch().flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
      ),
    )
  }

  status(): ReturnType<OwnedConversation["status"]> {
    this.#check()
    return {
      state: this.#running ? (this.#agent.busy ? this.#agent.status : "working") : this.#state,
      busy: !!this.#running || this.#agent.busy,
    }
  }

  #executionReady(): void {
    if (!this.#canExecute()) {
      this.#state = "error"
      throw new Error("owned conversation cannot execute during host initialization or reload")
    }
  }

  async send(text: string, options?: { signal?: AbortSignal }): Promise<void> {
    this.#check()
    if (options?.signal?.aborted) {
      if (!this.#running) this.#state = "stopped"
      options.signal.throwIfAborted()
    }
    this.#executionReady()
    if (this.#running || this.#agent.busy || this.#stopping) throw new Error("owned conversation is busy")
    this.#state = "idle"
    const controller = new AbortController()
    this.#abort = controller
    const abort = () => {
      controller.abort(options?.signal?.reason)
      this.#agent.abort()
    }
    options?.signal?.addEventListener("abort", abort, { once: true })
    this.#running = (async () => {
      const result = await this.#agent.tree!.runRoot(
        this.#agent,
        () => this.#agent.prompt(text),
        controller.signal,
      )
      this.#state = result.reason === "error" ? "error" : result.reason === "aborted" ? "stopped" : "idle"
      if (result.reason === "error") throw new Error(result.error ?? "owned conversation turn failed")
    })()
      .catch((error: unknown) => {
        this.#state = controller.signal.aborted ? "stopped" : "error"
        throw error
      })
      .finally(() => {
        options?.signal?.removeEventListener("abort", abort)
        this.#running = undefined
        this.#abort = undefined
      })
    await this.#running
  }

  stop(reason = "owned conversation stopped"): Promise<void> {
    this.#check()
    if (this.#stopping) return this.#stopping
    this.#abort?.abort(new Error(reason))
    this.#agent.abort()
    this.#agent.tree?.abortAll(reason)
    this.#stopping = (async () => {
      await this.#running?.catch(() => {})
      await this.#agent.currentTurn?.catch(() => {})
      await this.#agent.tree?.waitForChildren()
      this.#state = "stopped"
    })().finally(() => {
      this.#stopping = undefined
    })
    return this.#stopping
  }

  release(): Promise<void> {
    if (this.#release) return this.#release
    this.#released = true
    this.#abort?.abort(new Error("owned conversation released"))
    this.#release = (async () => {
      try {
        await this.#agent.dispose()
        await this.#running?.catch(() => {})
      } finally {
        this.#agent.tree?.releaseScope()
        this.events.close()
        try {
          await this.#agent.bus.flush()
          await this.#trace.close()
        } finally {
          this.#onRelease()
        }
      }
    })()
    return this.#release
  }

  createGroup(options: SpawnGroupOptions) {
    this.#check()
    this.#executionReady()
    return this.#agent.tree!.createGroup(this.#agent, options)
  }
}
