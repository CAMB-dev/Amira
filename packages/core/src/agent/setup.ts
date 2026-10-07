// Synchronous session composition; lifecycle ownership and public dispatch stay with Agent.
import path from "node:path"
import type { Ai, AssistantMessage, Message, ModelInfo, ToolSpec, Usage } from "@amira/ai"
import type { AskQuestion, OutputStore, ToolDefinition, ToolSession } from "@amira/api"
import { ArtifactStore, artifactDir } from "../artifacts.ts"
import { type CompactionOptions, contextTokens } from "../compaction.ts"
import type { ContextOptions, ContextView } from "../context.ts"
import { createToolSession } from "../deferred-tools.ts"
import type { EventBus } from "../event-bus.ts"
import { FILE_REWIND_COVERAGE, type FileRewind } from "../file-rewind.ts"
import type { InterceptorRegistry } from "../interceptors.ts"
import type { SessionStore } from "../session-store.ts"
import type { PauseGate } from "../subagents/pause.ts"
import type { ToolRegistry } from "../tool-registry.ts"
import type { ApprovalGate } from "./approvals.ts"
import { Compactor } from "./compactor.ts"
import type { buildContext } from "./context-builder.ts"
import { ContextManager } from "./context-manager.ts"
import { type History, keptHistoryViews } from "./history.ts"
import { modelRef } from "./messages.ts"
import type { Emit, Turn } from "./types.ts"

/** Recovery failures leave the session open so its owner can resolve or abandon the restore. */
export function recoverFileRewind(fileRewind: FileRewind | undefined, source: { fileRewind?: FileRewind }) {
  let recovered: ReturnType<FileRewind["recover"]>
  let unrecovered: string | undefined
  try {
    recovered = !source.fileRewind ? fileRewind?.recover() : undefined
  } catch (error) {
    // The session must still open: the user resolves the conflicts or abandons the restore.
    unrecovered = (error as Error).message
  }
  return { recovered, unrecovered }
}

/** Report only after session identity and the event bus have been initialized. */
export function reportFileRewind(
  bus: EventBus,
  sessionId: string,
  { recovered, unrecovered }: ReturnType<typeof recoverFileRewind>,
): void {
  if (recovered || unrecovered) {
    bus.emit(
      "extension.notice",
      {
        source: "file-rewind",
        level: recovered ? "info" : "warning",
        text: recovered
          ? `Finished interrupted file restore: ${recovered.restored} restored, ${recovered.removed} removed. ${FILE_REWIND_COVERAGE}`
          : `An interrupted file restore could not finish, and file tools cannot write until it does. ${unrecovered}\nResolve the conflicts and rewind to the same message with files, or rewind the conversation only to abandon it.`,
      },
      { sessionId },
    )
  }
}

interface HistorySource {
  messages?: Message[]
  session?: SessionStore
  views?: ReadonlyMap<Message, ContextView>
}

/** Restore before constructing History; callers bind originals only after restoration. */
export function restoreHistory(source: HistorySource, loadedTools: Set<string>) {
  let history: ConstructorParameters<typeof History>[1]
  let tokens: number | undefined
  let restoredTools: string[] | undefined
  if (source.messages || !source.session) {
    const messages = source.messages ?? []
    // An interrupted reply may carry no usage counted; the one before it tells the context.
    const last = messages.findLast((m) => m.role === "assistant" && m.usage && contextTokens(m.usage) > 0) as
      | AssistantMessage
      | undefined
    if (last?.usage) tokens = contextTokens(last.usage)
    history = { messages, views: keptHistoryViews(messages, source.views) }
  } else {
    const restored = source.session.restore()
    history = restored
    tokens = restored.contextTokens
    for (const name of restored.loadedTools) loadedTools.add(name)
    if (restored.loadedTools.length) restoredTools = restored.loadedTools
  }
  return { history, tokens, restoredTools }
}

/** A fork still finds the artifacts named by its copied history beside the new session. */
export function createSessionArtifacts(
  source: { session?: SessionStore; outputsParent?: OutputStore },
  sessionId: string,
  context: ContextOptions,
): ArtifactStore {
  const forkedFrom = source.session?.header.parent
  const outputsParent =
    source.outputsParent ??
    (forkedFrom && source.session
      ? new ArtifactStore({
          dir: artifactDir(path.join(path.dirname(source.session.file), `${forkedFrom}.jsonl`), forkedFrom),
          sessionId: forkedFrom,
        })
      : undefined)
  return new ArtifactStore({
    dir: artifactDir(source.session?.file, sessionId),
    sessionId,
    limits: {
      ...(context.saveAbove !== undefined ? { saveAbove: context.saveAbove } : {}),
      ...(context.previewChars !== undefined ? { previewChars: context.previewChars } : {}),
    },
    ...(context.quotaBytes !== undefined ? { quotaBytes: context.quotaBytes } : {}),
    ...(outputsParent ? { parent: outputsParent } : {}),
  })
}

interface ContextSetup {
  ai: Ai
  model: () => ModelInfo
  context: ContextOptions
  compaction: CompactionOptions
  history: History
  artifacts: ArtifactStore
  tools: ToolRegistry
  toolFor: ConstructorParameters<typeof ContextManager>[0]["toolFor"]
  cwd: string
  interceptors: InterceptorRegistry
  session: SessionStore | undefined
  sessionId: string
  isSubAgent: boolean
  execution: PauseGate
  buildContext: (signal: AbortSignal) => ReturnType<typeof buildContext>
  renderSections: () => string
  offeredTools: () => ToolSpec[]
  recordTreeUsage: (usage: Usage) => void
  emit: Emit
}

/** Link context projections and compaction without transferring turn or hold ownership. */
export function setupContext(deps: ContextSetup, tokens: number | undefined) {
  const contextManager = new ContextManager(
    {
      history: deps.history,
      artifacts: deps.artifacts,
      tools: deps.tools,
      toolFor: deps.toolFor,
      cwd: deps.cwd,
      options: deps.context,
      model: deps.model,
      replayTarget: () => deps.ai.replayTarget(deps.model()),
      fixedChars: () => deps.renderSections().length + JSON.stringify(deps.offeredTools()).length,
      emit: deps.emit,
    },
    { contextTokens: tokens },
  )
  const compactor = new Compactor({
    ai: deps.ai,
    model: deps.model,
    options: deps.compaction,
    history: deps.history,
    context: contextManager,
    interceptors: deps.interceptors,
    session: deps.session,
    sessionId: deps.sessionId,
    isSubAgent: deps.isSubAgent,
    execution: deps.execution,
    buildContext: deps.buildContext,
    renderSections: deps.renderSections,
    offeredTools: deps.offeredTools,
    recordTreeUsage: deps.recordTreeUsage,
    emit: deps.emit,
  })
  return { contextManager, compactor }
}

interface ToolSessionSetup {
  sessionId: string
  tools: ToolRegistry
  loadedTools: Set<string>
  allowsTool: (tool: ToolDefinition) => boolean
  session: SessionStore | undefined
  history: History
  artifacts: ArtifactStore
  contextHas: (text: string) => boolean
  depth: number
  maxDepth: () => number
  model: () => ModelInfo
  spawning: Pick<ToolSession, "spawn" | "createGroup" | "groups"> | undefined
  expectNotice: ToolSession["expectNotice"]
}

/** Base tool capabilities keep model/depth and notice targeting live. */
export function setupToolSession(deps: ToolSessionSetup): ToolSession {
  const deferred = createToolSession(deps.sessionId, deps.tools, deps.loadedTools, deps.allowsTool)
  return {
    ...deferred,
    ...(deps.session ? { dir: deps.session.file.replace(/\.jsonl$/, "") } : {}),
    data: deps.history.data,
    outputs: deps.artifacts,
    contextHas: deps.contextHas,
    // Recorded in the session, so resuming it offers the same tools again.
    loadTools: (names) => {
      const added = deferred.loadTools(names)
      if (added.length) deps.history.store({ type: "tools_loaded", names: added })
      return added
    },
    depth: deps.depth,
    get maxDepth() {
      return deps.maxDepth()
    },
    get model() {
      return modelRef(deps.model())
    },
    ...deps.spawning,
    // Persistent sub-agents are woken by their owner; one-turn children cannot be woken.
    ...(deps.expectNotice ? { expectNotice: deps.expectNotice } : {}),
  }
}

/** Per-call descriptors retain the base getters and attribute spawned work to its tool call. */
export function callToolSession(
  base: ToolSession,
  approvals: ApprovalGate,
  turn: Turn,
  toolCallId: string,
  createGroup: ToolSession["createGroup"],
): ToolSession {
  const spawn = base.spawn
  const props: PropertyDescriptorMap = {
    ...(approvals.hasAsker
      ? {
          askUser: {
            value: (questions: AskQuestion[], signal?: AbortSignal) =>
              approvals.askFromTool(turn, toolCallId, questions, signal),
            enumerable: true,
          },
        }
      : {}),
  }
  if (spawn && createGroup) {
    props.spawn = {
      value: (o: Parameters<typeof spawn>[0]) => spawn({ ...o, toolCallId: o.toolCallId ?? toolCallId }),
      enumerable: true,
    }
    props.createGroup = { value: createGroup, enumerable: true }
  }
  return Object.keys(props).length ? (Object.create(base, props) as ToolSession) : base
}
