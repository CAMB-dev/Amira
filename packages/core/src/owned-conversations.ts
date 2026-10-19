import { existsSync, rmSync } from "node:fs"
import path from "node:path"
import { type Ai, hasFastMode, type Message, userMessage } from "@amira/ai"
import type {
  ConversationRuntime,
  ConversationSpec,
  OwnedConversation,
  OwnedConversationRef,
  OwnedConversationSnapshot,
  OwnedConversations,
  SpawnGroupOptions,
} from "@amira/api"
import { drainOwnedBackgroundJobs, hasOwnedBackgroundJobs } from "./agent/background-jobs.ts"
import { drainOwnedTools, runOwnedTool } from "./agent/owned-tool.ts"
import { Agent } from "./agent.ts"
import { checkAskAnswers } from "./ask-answers.ts"
import { completeForAgent } from "./completion.ts"
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
  readOwnedLifecycle,
  readOwnedRef,
  readOwnedStore,
  type SavedConversation,
  validateSpec,
  writeOwnedLifecycle,
} from "./owned-conversations-storage.ts"
import { conversationUsage } from "./owned-conversations-usage.ts"
import {
  registerConversationHold,
  registerConversationScope,
  registerConversationSend,
  registerConversationTurn,
  releaseConversationIncarnation,
  sessionScopeContains,
} from "./session-routing.ts"
import { sessionLockFile } from "./session-store.ts"
import { approveWithHost } from "./subagents/host-approval.ts"
import { scopeAdmission } from "./subagents/lifecycle.ts"
import { routeTreeToHuman } from "./subagents/question-routing.ts"
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
  #changes = new Map<string, { owner: string; archive: boolean; done: Promise<void> }>()
  #claims = new Map<string, { owner: string; id: string; lease: Awaited<ReturnType<typeof claimOwned>> }>()

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
          v: spec.writeRoots !== undefined || spec.descendants === "inherit" ? 2 : 1,
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
      read: async (ref) => {
        check()
        const saved = readOwnedRef(this.#home, owner, ref)
        if (!saved) return undefined
        const lifecycle = readOwnedLifecycle(this.#home, saved)
        if (lifecycle === "archiving")
          throw new Error("owned conversation archive is incomplete; retry archive")
        const file = path.join(ownedDirectory(this.#home, owner), `${saved.id}.jsonl`)
        const active = this.#handles.get(file)?.handle
        if (active && !active.isReleased()) return active.snapshot()
        const store = readOwnedStore(this.#home, saved)
        // No lease is acquired for inspection. A foreign writer is an unverified coverage fact.
        const usage = conversationUsage(store, undefined, [
          { kind: "integrity", verified: !existsSync(sessionLockFile(file)) },
        ])
        return freeze({
          id: saved.id,
          key: saved.spec.key,
          name: saved.spec.name,
          cwd: saved.spec.cwd,
          archived: lifecycle === "archived",
          history: structuredClone(
            store.branch().flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
          ),
          usage,
        })
      },
      archive: async (ref) => {
        check()
        return this.#change(owner, ref, true, check)
      },
      unarchive: async (ref) => {
        check()
        return this.#change(owner, ref, false, check)
      },
    }
  }

  #change(owner: string, ref: OwnedConversationRef, archive: boolean, check: () => void): Promise<void> {
    // Validate before fencing, including foreign-owner denial. A pending first open may not
    // have published its identity yet; its validated reference still identifies the opening.
    const saved = readOwnedRef(this.#home, owner, ref)
    const id = "id" in ref ? ref.id : ownedId(owner, ref.key)
    const file = path.join(ownedDirectory(this.#home, owner), `${id}.jsonl`)
    const previous = this.#changes.get(file)
    if (!archive && (previous?.archive || (saved && readOwnedLifecycle(this.#home, saved) === "archiving")))
      throw new Error("owned conversation archive is incomplete; retry archive")
    // Retain the live writer and publish before any cancellation callback or release wait.
    // The synchronous fence closes admission only; cancellation starts after this commit.
    if (archive && saved)
      this.#handles
        .get(file)
        ?.handle.prepareArchive(() => writeOwnedLifecycle(this.#home, saved, "archiving"))
    const done = (async () => {
      // Yield only after the map below has closed admission, then drain any in-flight open.
      await previous?.done.catch(() => {})
      check()
      await this.#openings.stop(owner, id)
      check()
      const saved = readOwnedRef(this.#home, owner, ref)
      if (!saved) throw new Error("owned conversation not found for this owner")
      let active = this.#handles.get(file)?.handle
      if (active && archive) {
        active.prepareArchive(() => writeOwnedLifecycle(this.#home, saved, "archiving"))
        await active.archive(() => writeOwnedLifecycle(this.#home, saved, "archived"))
        return
      }
      if (active?.isReleasing()) {
        await active.release()
        active = this.#handles.get(file)?.handle
      }
      if (active) {
        if (readOwnedLifecycle(this.#home, saved) === "archiving")
          throw new Error("owned conversation archive is incomplete; retry archive")
        return // Already active. Unarchive never replaces a live incarnation.
      }
      const lease =
        this.#claims.get(file)?.lease ?? (await claimOwned(this.#home, saved, false, { historical: true }))
      if (archive) this.#claims.set(file, { owner, id, lease })
      try {
        check()
        const state = readOwnedLifecycle(this.#home, saved)
        if (archive) {
          if (state !== "archived" || hasOwnedBackgroundJobs(lease.store.file)) {
            writeOwnedLifecycle(this.#home, saved, "archiving")
            await drainOwnedBackgroundJobs(lease.store.file, id)
            writeOwnedLifecycle(this.#home, saved, "archived")
          }
        } else {
          if (state === "archiving")
            throw new Error("owned conversation archive is incomplete; retry archive")
          if (state === "archived") writeOwnedLifecycle(this.#home, saved, "active")
        }
      } catch (error) {
        if (!archive) lease.release()
        throw error
      }
      lease.release()
      this.#claims.delete(file)
    })().finally(() => {
      if (this.#changes.get(file)?.done === done) this.#changes.delete(file)
    })
    this.#changes.set(file, { owner, archive, done })
    if (archive) this.#handles.get(file)?.handle.waitForArchive(done)
    return done
  }

  async #open(
    saved: SavedConversation,
    runtime: ConversationRuntime,
    create = false,
  ): Promise<OwnedConversation> {
    const { owner, id, spec } = saved
    const file = path.join(ownedDirectory(this.#home, owner), `${id}.jsonl`)
    if (this.#changes.has(file)) throw new Error("owned conversation archive/unarchive is in progress")
    if (!create && readOwnedLifecycle(this.#home, saved) !== "active")
      throw new Error("owned conversation is archived or its archive is incomplete")
    validateRuntime(saved, runtime)
    const existing = this.#handles.get(file)
    if (existing) {
      if (existing.handle.isReleased())
        throw new Error("owned conversation is in use while its owner is unloading")
      return existing.handle
    }
    const main = this.#opts.agent()
    const model = this.#opts.ai.model(spec.model)
    const opening = this.#openings.begin(owner, id)
    try {
      const lease = await claimOwned(this.#home, saved, create, { signal: opening.signal })
      let tree: AgentTree | undefined
      try {
        opening.signal.throwIfAborted()
        if (this.#changes.has(file)) throw new Error("owned conversation archive/unarchive is in progress")
        if (create) {
          lease.store.appendDisplay({ type: "display", text: `Conversation: ${spec.name}`, level: "info" })
          publishOwned(this.#home, saved)
        } else if (!existsSync(path.join(ownedDirectory(this.#home, owner), `${id}.spec.json`))) {
          publishOwned(this.#home, saved)
        }
        tree = new AgentTree({
          ai: this.#opts.ai,
          shared: this.#opts.tree,
          restricted: spec.descendants !== "inherit",
          sections: () => [],
        })
        routeTreeToHuman(tree)
        const initialState = restoredConversationState(lease.store)
        const agent = new Agent({
          ai: this.#opts.ai,
          model,
          cwd: spec.cwd,
          writeRoots: spec.writeRoots,
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
          fastMode: main.fastMode && hasFastMode(model),
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
            if (this.#handles.get(file)?.handle === handle) this.#handles.delete(file)
          },
          initialState,
          this.#opts.canExecute ?? (() => true),
          this.#opts.ai,
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
    // Revoke ordinary handles synchronously; archival already fenced the remaining ones.
    const releasing = [...this.#handles]
      .filter(([file, entry]) => entry.owner === owner && !this.#changes.has(file))
      .map(([, entry]) => entry.handle.release())
    await Promise.all([
      pending,
      ...releasing,
      Promise.allSettled(
        [...this.#changes.values()].filter((entry) => entry.owner === owner).map((entry) => entry.done),
      ).then(async () => {
        await Promise.all(
          [...this.#handles.values()]
            .filter((entry) => entry.owner === owner)
            .map((entry) => entry.handle.release()),
        )
        await this.#releaseClaims(owner)
      }),
    ])
  }

  async #releaseClaims(owner?: string): Promise<void> {
    await Promise.all(
      [...this.#claims]
        .filter(([file, entry]) => (owner === undefined || entry.owner === owner) && !this.#changes.has(file))
        .map(async ([file, entry]) => {
          await drainOwnedBackgroundJobs(entry.lease.store.file, entry.id)
          // A new owner may have taken over this claim while shutdown was awaiting I/O.
          if (this.#claims.get(file) !== entry || this.#changes.has(file)) return
          entry.lease.release()
          this.#claims.delete(file)
        }),
    )
  }

  async drain(): Promise<void> {
    this.#closed = true
    await this.#openings.stop()
    await Promise.all([...this.#owners.keys()].map((owner) => this.releaseOwner(owner)))
    await Promise.all([...this.#handles.values()].map((entry) => entry.handle.release()))
    await this.#releaseClaims()
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
  #ai: Ai
  #state: InactiveConversationState
  #canExecute: () => boolean
  #stopping: Promise<void> | undefined
  #running: Promise<void> | undefined
  #abort: AbortController | undefined
  #trace: TraceRecorder
  #released = false
  #archiving = false
  #archivePrepared = false
  #finalized = false
  #archiveWait: Promise<void> | undefined
  #release: Promise<void> | undefined
  #onRelease: () => void

  constructor(
    spec: ConversationSpec,
    agent: Agent,
    onRelease: () => void,
    state: InactiveConversationState,
    canExecute: () => boolean,
    ai: Ai,
  ) {
    this.#ai = ai
    this.#state = state
    this.#canExecute = canExecute
    this.id = agent.sessionId
    registerConversationScope(
      this,
      (id) => !this.#released && sessionScopeContains(agent.tree, id, agent.sessionId),
      agent,
    )
    registerConversationTurn(this, () => (this.#released ? undefined : agent.turnId))
    registerConversationHold(this, () => (this.#released ? undefined : agent.holdId))
    registerConversationSend(this, (text, options, turnId) => this.send(text, options, turnId))
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

  isReleasing(): boolean {
    return !!this.#release
  }

  #check(): void {
    if (this.#released) throw new Error("owned conversation has been released")
    if (this.#archiving) throw new Error("owned conversation archive is incomplete; retry archive")
  }

  /** Close retained groups as well as direct calls before cancellation can yield. */
  fence(): void {
    if (this.#archiving) return
    this.#archiving = true
    scopeAdmission(this.#agent.tree!).fence()
  }

  prepareArchive(persist: () => void): void {
    this.fence()
    if (this.#archivePrepared) return
    persist()
    this.#archivePrepared = true
  }

  waitForArchive(done: Promise<void>): void {
    this.#archiveWait = done
    const clear = () => {
      if (this.#archiveWait === done) this.#archiveWait = undefined
    }
    void done.then(clear, clear)
  }

  async archive(publish: () => void): Promise<void> {
    if (this.#finalized) return
    if (!this.#archivePrepared)
      throw new Error("owned conversation archive fence is not durable; retry archive")
    scopeAdmission(this.#agent.tree!).cancel()
    this.#abort?.abort(new Error("owned conversation archived"))
    await this.#release
    await this.#agent.dispose()
    await this.#running?.catch(() => {})
    await scopeAdmission(this.#agent.tree!).drain()
    await drainOwnedBackgroundJobs(this.#agent.session!.file, this.id)
    this.events.close()
    await this.#agent.bus.flush()
    await this.#trace.close()
    // Keep the writer lease on any drain/publication failure. A retry must finish this
    // incarnation's drain, not certify archival while its tools could still be running.
    this.#released = true
    releaseConversationIncarnation(this)
    this.#agent.tree?.releaseScope()
    publish()
    this.#onRelease()
    this.#finalized = true
  }

  history(): readonly Message[] {
    this.#check()
    return freeze(
      structuredClone(
        this.#agent.session!.branch().flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
      ),
    )
  }

  usage(): ReturnType<OwnedConversation["usage"]> {
    this.#check()
    return conversationUsage(this.#agent)
  }

  snapshot(): OwnedConversationSnapshot {
    return freeze({
      id: this.id,
      key: this.key,
      name: this.name,
      cwd: this.cwd,
      archived: false,
      history: this.history(),
      usage: this.usage(),
    })
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

  async send(
    text: string,
    options?: Parameters<OwnedConversation["send"]>[1],
    turnId?: string,
  ): Promise<void> {
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
        () =>
          this.#agent
            .prompt(
              options?.images?.length
                ? {
                    role: "user",
                    content: [...(text ? [{ type: "text" as const, text }] : []), ...options.images],
                    ...(options.display ? { display: options.display } : {}),
                  }
                : options?.display
                  ? userMessage(text, options.display)
                  : text,
              { turnId },
            )
            .then(async (result) => {
              await drainOwnedTools(this.#agent)
              return result
            }),
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

  async runTool(
    name: string,
    args: Record<string, unknown>,
    options?: Parameters<OwnedConversation["runTool"]>[2],
  ): Promise<import("@amira/api").ToolResult> {
    this.#check()
    this.#executionReady()
    if (this.#running || this.#agent.busy || this.#stopping) throw new Error("owned conversation is busy")
    args = structuredClone(args)
    const controller = new AbortController()
    this.#abort = controller
    const abort = () => {
      controller.abort(options?.signal?.reason)
      this.#agent.abort()
    }
    if (options?.signal?.aborted) abort()
    else options?.signal?.addEventListener("abort", abort, { once: true })
    const operation = this.#agent
      .tree!.runRoot(
        this.#agent,
        () => runOwnedTool(this.#agent, name, args, { signal: controller.signal }),
        controller.signal,
      )
      .then(({ result, aborted }) => {
        this.#state = aborted ? "stopped" : result.isError ? "error" : "idle"
        return result
      })
      .catch((error: unknown) => {
        this.#state = controller.signal.aborted ? "stopped" : "error"
        return {
          content: [
            {
              type: "text" as const,
              text: `Tool invocation failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        }
      })
    this.#running = operation
      .then(() => {})
      .finally(() => {
        options?.signal?.removeEventListener("abort", abort)
        this.#running = undefined
        this.#abort = undefined
      })
    await this.#running
    return operation
  }

  async complete(
    request: Parameters<OwnedConversation["complete"]>[0],
  ): ReturnType<OwnedConversation["complete"]> {
    this.#check()
    this.#executionReady()
    if (this.#running || this.#agent.busy || this.#stopping) throw new Error("owned conversation is busy")
    request.signal?.throwIfAborted()
    const controller = new AbortController()
    this.#abort = controller
    const operation = completeForAgent({
      ai: this.#ai,
      agent: this.#agent,
      model: this.#agent.model,
      request,
      signal: controller.signal,
      label: "owned completion",
      admission: true,
    })
      .then((result) => {
        this.#state = "idle"
        return result
      })
      .catch((error: unknown) => {
        this.#state = controller.signal.aborted || request.signal?.aborted ? "stopped" : "error"
        throw error
      })
    this.#running = operation
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        this.#running = undefined
        this.#abort = undefined
      })
    try {
      return await operation
    } finally {
      await this.#running
    }
  }

  stop(reason = "owned conversation stopped"): Promise<void> {
    this.#check()
    if (this.#stopping) return this.#stopping
    const resumeAdmission = scopeAdmission(this.#agent.tree!).suspend()
    this.#abort?.abort(new Error(reason))
    this.#agent.abort()
    this.#agent.tree?.abortAll(reason)
    this.#stopping = (async () => {
      await this.#running?.catch(() => {})
      await this.#agent.currentTurn?.catch(() => {})
      await this.#agent.tree?.waitForChildren()
      await scopeAdmission(this.#agent.tree!).drain()
      this.#state = "stopped"
    })().finally(() => {
      resumeAdmission()
      this.#stopping = undefined
    })
    return this.#stopping
  }

  release(): Promise<void> {
    if (this.#release) return this.#release
    if (this.#finalized) return Promise.resolve()
    if (this.#archiveWait) return this.#archiveWait
    if (this.#archiving) return this.archive(() => {})
    this.#released = true
    releaseConversationIncarnation(this)
    scopeAdmission(this.#agent.tree!).suspend()
    this.#abort?.abort(new Error("owned conversation released"))
    this.#release = (async () => {
      try {
        await this.#agent.dispose()
        await this.#running?.catch(() => {})
        await scopeAdmission(this.#agent.tree!).drain()
      } finally {
        this.#agent.tree?.releaseScope()
        this.events.close()
        try {
          await this.#agent.bus.flush()
          await this.#trace.close()
        } finally {
          // Archive can take over while this drain is awaiting disposal/trace I/O.
          // Its durable fence and final publication must retain the same writer lease.
          if (!this.#archiving) this.#onRelease()
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
