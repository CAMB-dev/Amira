import type {
  BackgroundJobChange,
  BackgroundJobHost,
  BackgroundJobInfo,
  BackgroundJobOutput,
  BackgroundJobSession,
  BackgroundJobSessionInfo,
  BackgroundJobStartOptions,
  BackgroundJobWaitOptions,
  BackgroundJobWaitResult,
} from "@amira/api"
import {
  DEFAULT_BUFFER_CHARS,
  DEFAULT_MAX_RUNNING,
  type JobChange,
  type JobRegistry,
  type StartJobOptions,
} from "@amira/proc"

interface Scope {
  readonly sessionId: string
  readonly depth: number
  readonly rootSessionId: string
  readonly listeners: Set<() => void>
  active: boolean
}

/**
 * Adds session ownership and visibility to the process registry without making @amira/api
 * depend on @amira/proc. The process registry remains the lifecycle primitive; this class is the
 * host implementation of the public contract.
 */
export class SessionBackgroundJobHost implements BackgroundJobHost {
  readonly #registry: JobRegistry
  readonly #roots = new Map<string, string>()
  readonly #scopes = new Set<Scope>()
  readonly #listeners = new Set<(change: BackgroundJobChange) => void>()
  readonly #pendingRoots: (string | undefined)[] = []

  constructor(registry: JobRegistry) {
    this.#registry = registry
    registry.subscribe((change) => this.#changed(change))
  }

  get maxRunning(): number {
    return this.#registry.maxRunning
  }

  configure(limits: { maxRunning?: number; bufferChars?: number }): void {
    this.#registry.configure({
      maxRunning: limits.maxRunning ?? DEFAULT_MAX_RUNNING,
      bufferChars: limits.bufferChars ?? DEFAULT_BUFFER_CHARS,
    })
  }

  isLimitError(error: unknown): error is Error {
    return this.#registry.isLimitError(error)
  }

  start(options: BackgroundJobStartOptions): BackgroundJobInfo {
    return this.#start(options)
  }

  get(id: string): BackgroundJobInfo | undefined {
    this.#forgetPruned()
    return this.#registry.get(id)
  }

  list(): BackgroundJobInfo[] {
    this.#forgetPruned()
    return this.#registry.list()
  }

  running(): BackgroundJobInfo[] {
    return this.#registry.running()
  }

  output(id: string, from = 0): BackgroundJobOutput {
    return this.#registry.output(id, from)
  }

  tail(id: string, maxChars: number): string {
    return this.#registry.tail(id, maxChars)
  }

  cursor(id: string, reader: string): number {
    return this.#registry.cursor(id, reader)
  }

  readNew(id: string, reader: string, maxChars?: number): BackgroundJobOutput {
    return this.#registry.readNew(id, reader, maxChars)
  }

  markRead(id: string, reader: string, to?: number): void {
    this.#registry.markRead(id, reader, to)
  }

  waitFor(id: string, options: BackgroundJobWaitOptions): Promise<BackgroundJobWaitResult> {
    return this.#registry.waitFor(id, options)
  }

  stop(id: string, graceMs?: number): Promise<BackgroundJobInfo> {
    return this.#registry.stop(id, graceMs)
  }

  stopAll(which?: (job: BackgroundJobInfo) => boolean, graceMs?: number): Promise<BackgroundJobInfo[]> {
    return this.#registry.stopAll(which, graceMs)
  }

  subscribe(listener: (change: BackgroundJobChange) => void): () => void {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  forSession(info: BackgroundJobSessionInfo): BackgroundJobSession {
    const parent = info.parentSessionId
      ? [...this.#scopes].find((scope) => scope.active && scope.sessionId === info.parentSessionId)
      : undefined
    const rootSessionId =
      info.rootSessionId ??
      parent?.rootSessionId ??
      (info.depth === 0 ? info.sessionId : (info.parentSessionId ?? info.sessionId))
    const scope: Scope = {
      sessionId: info.sessionId,
      depth: info.depth,
      rootSessionId,
      listeners: new Set(),
      active: true,
    }
    this.#scopes.add(scope)
    return new SessionBackgroundJobs(this, scope)
  }

  async closeSession(sessionId: string, graceMs = 2000): Promise<BackgroundJobInfo[]> {
    for (const scope of [...this.#scopes]) if (scope.sessionId === sessionId) this.#closeScope(scope)
    return this.#registry.stopAll((job) => job.owner === sessionId, graceMs)
  }

  async closeRoot(rootSessionId: string, graceMs = 2000): Promise<BackgroundJobInfo[]> {
    for (const scope of [...this.#scopes]) if (scope.rootSessionId === rootSessionId) this.#closeScope(scope)
    return this.#registry.stopAll((job) => this.#roots.get(job.id) === rootSessionId, graceMs)
  }

  startIn(scope: Scope, options: BackgroundJobStartOptions): BackgroundJobInfo {
    if (!scope.active) throw new Error(`background job session "${scope.sessionId}" has ended`)
    return this.#start(options, scope)
  }

  getIn(scope: Scope, id: string): BackgroundJobInfo | undefined {
    const job = this.#registry.get(id)
    return job && this.#visible(scope, job) ? job : undefined
  }

  listIn(scope: Scope): BackgroundJobInfo[] {
    return this.list().filter((job) => this.#visible(scope, job))
  }

  outputIn(scope: Scope, id: string, from?: number): BackgroundJobOutput {
    this.#needIn(scope, id)
    return this.#registry.output(id, from)
  }

  tailIn(scope: Scope, id: string, maxChars: number): string {
    this.#needIn(scope, id)
    return this.#registry.tail(id, maxChars)
  }

  cursorIn(scope: Scope, id: string, reader: string): number {
    this.#needIn(scope, id)
    return this.#registry.cursor(id, this.#reader(scope, reader))
  }

  readNewIn(scope: Scope, id: string, reader: string, maxChars?: number): BackgroundJobOutput {
    this.#needIn(scope, id)
    return this.#registry.readNew(id, this.#reader(scope, reader), maxChars)
  }

  markReadIn(scope: Scope, id: string, reader: string, to?: number): void {
    this.#needIn(scope, id)
    this.#registry.markRead(id, this.#reader(scope, reader), to)
  }

  waitForIn(scope: Scope, id: string, options: BackgroundJobWaitOptions): Promise<BackgroundJobWaitResult> {
    this.#needIn(scope, id)
    return this.#registry.waitFor(id, options)
  }

  stopIn(scope: Scope, id: string, graceMs?: number): Promise<BackgroundJobInfo> {
    this.#needIn(scope, id)
    return this.#registry.stop(id, graceMs)
  }

  subscribeIn(scope: Scope, listener: (change: BackgroundJobChange) => void): () => void {
    const off = this.subscribe((change) => {
      if (this.#visible(scope, change.job)) listener(change)
    })
    scope.listeners.add(off)
    return () => {
      scope.listeners.delete(off)
      off()
    }
  }

  #closeScope(scope: Scope): void {
    scope.active = false
    for (const off of scope.listeners) off()
    scope.listeners.clear()
    this.#scopes.delete(scope)
  }

  #start(options: BackgroundJobStartOptions, scope?: Scope): BackgroundJobInfo {
    const shell = options.shell ?? options.shellKind
    const meta = shell ? { ...options.meta, shellKind: shell } : options.meta
    const raw: StartJobOptions = {
      command: options.command,
      argv: options.argv,
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
      ...(options.gated ? { gated: true } : {}),
      ...(options.gateLine !== undefined ? { gateLine: options.gateLine } : {}),
      ...(options.viaCmd ? { viaCmd: true } : {}),
      ...(options.logDir ? { logDir: options.logDir } : {}),
      ...(options.maxLogBytes !== undefined ? { maxLogBytes: options.maxLogBytes } : {}),
      ...(scope && scope.depth > 0 ? { owner: scope.sessionId } : {}),
      ...(meta ? { meta } : {}),
    }
    this.#pendingRoots.push(scope?.rootSessionId)
    try {
      const job = this.#registry.start(raw)
      this.#roots.set(job.id, scope?.rootSessionId ?? "")
      return job
    } finally {
      this.#pendingRoots.pop()
    }
  }

  #changed(change: JobChange): void {
    if (!this.#roots.has(change.job.id)) {
      const root = this.#pendingRoots.at(-1)
      if (root !== undefined) this.#roots.set(change.job.id, root)
    }
    const publicChange = change as BackgroundJobChange
    for (const listener of [...this.#listeners]) {
      try {
        listener(publicChange)
      } catch {
        // A listener cannot break the registry's bookkeeping or another listener.
      }
    }
  }

  #visible(scope: Scope, job: BackgroundJobInfo): boolean {
    if (!scope.active) return false
    return scope.depth === 0 ? this.#roots.get(job.id) === scope.rootSessionId : job.owner === scope.sessionId
  }

  #needIn(scope: Scope, id: string): BackgroundJobInfo {
    const job = this.getIn(scope, id)
    if (!job) throw new Error(`no background job "${id}"`)
    return job
  }

  #reader(scope: Scope, reader: string): string {
    return `${scope.sessionId}\0${reader}`
  }

  #forgetPruned(): void {
    for (const id of this.#roots.keys()) if (!this.#registry.get(id)) this.#roots.delete(id)
  }
}

class SessionBackgroundJobs implements BackgroundJobSession {
  readonly sessionId: string
  readonly depth: number
  readonly #host: SessionBackgroundJobHost
  readonly #scope: Scope

  constructor(host: SessionBackgroundJobHost, scope: Scope) {
    this.#host = host
    this.#scope = scope
    this.sessionId = scope.sessionId
    this.depth = scope.depth
  }

  isLimitError(error: unknown): error is Error {
    return this.#host.isLimitError(error)
  }

  start(options: BackgroundJobStartOptions): BackgroundJobInfo {
    return this.#host.startIn(this.#scope, options)
  }

  get(id: string): BackgroundJobInfo | undefined {
    return this.#host.getIn(this.#scope, id)
  }

  list(): BackgroundJobInfo[] {
    return this.#host.listIn(this.#scope)
  }

  running(): BackgroundJobInfo[] {
    return this.list().filter((job) => job.status === "starting" || job.status === "running")
  }

  output(id: string, from?: number): BackgroundJobOutput {
    return this.#host.outputIn(this.#scope, id, from)
  }

  tail(id: string, maxChars: number): string {
    return this.#host.tailIn(this.#scope, id, maxChars)
  }

  cursor(id: string, reader: string): number {
    return this.#host.cursorIn(this.#scope, id, reader)
  }

  readNew(id: string, reader: string, maxChars?: number): BackgroundJobOutput {
    return this.#host.readNewIn(this.#scope, id, reader, maxChars)
  }

  markRead(id: string, reader: string, to?: number): void {
    this.#host.markReadIn(this.#scope, id, reader, to)
  }

  waitFor(id: string, options: BackgroundJobWaitOptions): Promise<BackgroundJobWaitResult> {
    return this.#host.waitForIn(this.#scope, id, options)
  }

  stop(id: string, graceMs?: number): Promise<BackgroundJobInfo> {
    return this.#host.stopIn(this.#scope, id, graceMs)
  }

  stopAll(which?: (job: BackgroundJobInfo) => boolean, graceMs?: number): Promise<BackgroundJobInfo[]> {
    return Promise.all(
      this.running()
        .filter(which ?? (() => true))
        .map((job) => this.stop(job.id, graceMs)),
    )
  }

  subscribe(listener: (change: BackgroundJobChange) => void): () => void {
    return this.#host.subscribeIn(this.#scope, listener)
  }
}

/**
 * One extension's view of the host jobs: the same host, except that the jobs it starts and the
 * listeners it subscribes end with the extension (`dispose`, run on unload or a failed load).
 * Jobs started by sessions' tools are not the extension's: they end with their session.
 */
export class ExtensionBackgroundJobs implements BackgroundJobHost {
  readonly #host: BackgroundJobHost
  readonly #started = new Set<string>()
  readonly #listeners = new Set<() => void>()

  constructor(host: BackgroundJobHost) {
    this.#host = host
  }

  get maxRunning(): number {
    return this.#host.maxRunning
  }

  configure(limits: { maxRunning?: number; bufferChars?: number }): void {
    this.#host.configure(limits)
  }

  isLimitError(error: unknown): error is Error {
    return this.#host.isLimitError(error)
  }

  start(options: BackgroundJobStartOptions): BackgroundJobInfo {
    const job = this.#host.start(options)
    this.#started.add(job.id)
    return job
  }

  get(id: string): BackgroundJobInfo | undefined {
    return this.#host.get(id)
  }

  list(): BackgroundJobInfo[] {
    return this.#host.list()
  }

  running(): BackgroundJobInfo[] {
    return this.#host.running()
  }

  output(id: string, from?: number): BackgroundJobOutput {
    return this.#host.output(id, from)
  }

  tail(id: string, maxChars: number): string {
    return this.#host.tail(id, maxChars)
  }

  cursor(id: string, reader: string): number {
    return this.#host.cursor(id, reader)
  }

  readNew(id: string, reader: string, maxChars?: number): BackgroundJobOutput {
    return this.#host.readNew(id, reader, maxChars)
  }

  markRead(id: string, reader: string, to?: number): void {
    this.#host.markRead(id, reader, to)
  }

  waitFor(id: string, options: BackgroundJobWaitOptions): Promise<BackgroundJobWaitResult> {
    return this.#host.waitFor(id, options)
  }

  stop(id: string, graceMs?: number): Promise<BackgroundJobInfo> {
    return this.#host.stop(id, graceMs)
  }

  stopAll(which?: (job: BackgroundJobInfo) => boolean, graceMs?: number): Promise<BackgroundJobInfo[]> {
    return this.#host.stopAll(which, graceMs)
  }

  subscribe(listener: (change: BackgroundJobChange) => void): () => void {
    const off = this.#host.subscribe(listener)
    const remove = () => {
      this.#listeners.delete(remove)
      off()
    }
    this.#listeners.add(remove)
    return remove
  }

  forSession(info: BackgroundJobSessionInfo): BackgroundJobSession {
    return this.#host.forSession(info)
  }

  closeSession(sessionId: string, graceMs?: number): Promise<BackgroundJobInfo[]> {
    return this.#host.closeSession(sessionId, graceMs)
  }

  closeRoot(rootSessionId: string, graceMs?: number): Promise<BackgroundJobInfo[]> {
    return this.#host.closeRoot(rootSessionId, graceMs)
  }

  /** Removes the extension's listeners and stops the jobs it started. */
  dispose(): void {
    for (const off of [...this.#listeners]) off()
    const started = this.#started
    if (started.size) void this.#host.stopAll((job) => started.has(job.id), 0)
  }
}
