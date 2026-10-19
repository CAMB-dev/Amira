import type { OwnedConversation, SessionControl, SubagentInfo } from "@amira/api"
import { type FrontendMessage, FrontendOperationError } from "@amira/core"
import { freezeSnapshot, frontendJson } from "../../../core/src/frontend/json.ts"
import { nativeConversationHistory } from "../../../core/src/frontend/native-conversations.ts"
import {
  conversationIncarnation,
  conversationScopeContains,
  isConversationIncarnation,
} from "../../../core/src/session-routing.ts"
import type { RemoteWorkspaceSnapshot } from "../remote-schema.ts"
import { copyHistory, historyPageEnd } from "./history-pages.ts"

export interface ServerConversationRef {
  conversationId: string
  incarnation?: string
}
export interface ServerConversationInfo {
  id: string
  name: string
  cwd: string
  incarnation: string
  state: ReturnType<OwnedConversation["status"]>["state"]
  busy: boolean
}
/** Replace scoped history/activity at this cursor, then apply only events above it.
 * All pages of a snapshot retain the same cut; buffer live events until paging completes.
 */
export interface ServerConversationCut {
  watermark: { daemonEpoch: string; seq: number }
  activity: RemoteWorkspaceSnapshot["activity"]
}

export interface ServerConversationOperations {
  "conversations.list": {
    params: Record<string, never>
    result: { subagents: SubagentInfo[]; conversations: ServerConversationInfo[] }
  }
  "conversations.history": {
    params: ServerConversationRef & { snapshot?: string; offset?: number; limit?: number }
    result: ServerConversationCut & {
      snapshot: string
      sessionGeneration: number
      messages: readonly FrontendMessage[]
      nextOffset?: number
    }
  }
  "conversations.focus": {
    params: ServerConversationRef
    result: ServerConversationRef & { sessionGeneration: number }
  }
  "conversations.unfocus": { params: Record<string, never>; result: { sessionGeneration: number } }
  "conversations.control": {
    params: { conversationId: string } & (
      | { action: "pause" | "resume" | "stop" }
      | { action: "message"; text: string }
    )
    result: { accepted: boolean; sessionGeneration: number }
  }
}

/** Runtime-owned native bindings survive frontend detach; no executable handles cross the wire. */
export function createServerConversations(deps: {
  control: SessionControl
  generation: () => number
  historyCut: (
    ref: ServerConversationRef,
    read: () => ReturnType<typeof copyHistory>,
  ) => { history: ReturnType<typeof copyHistory>; cut: ServerConversationCut }
  onFocus?: (ref: ServerConversationRef | null) => void
  now?: () => number
}) {
  const owned = new Map<string, { conversation: OwnedConversation; generation: number }>()
  const pages = new Map<
    string,
    {
      ref: ServerConversationRef
      generation: number
      expires: number
      messages: readonly FrontendMessage[]
      bytes: number
      sizes: number[]
      cut: ServerConversationCut
    }
  >()
  const now = deps.now ?? Date.now
  const stale = () =>
    new FrontendOperationError("stale_operation", "The conversation is unavailable in this scope")
  function resolve(ref: ServerConversationRef): OwnedConversation | undefined {
    const binding = owned.get(ref.conversationId)
    if (
      binding?.generation === deps.generation() &&
      ref.incarnation &&
      isConversationIncarnation(binding.conversation, ref.incarnation)
    )
      return binding.conversation
    if (
      ref.incarnation !== undefined ||
      !deps.control.subagents().some((child) => child.id === ref.conversationId)
    )
      throw stale()
    return undefined
  }
  const handlers = {
    "conversations.list": () => ({
      subagents: deps.control.subagents(),
      conversations: [...owned.values()].flatMap(({ conversation, generation }) => {
        const incarnation = conversationIncarnation(conversation)
        return generation === deps.generation() && isConversationIncarnation(conversation, incarnation)
          ? [
              {
                id: conversation.id,
                name: conversation.name,
                cwd: conversation.cwd,
                incarnation,
                ...conversation.status(),
              },
            ]
          : []
      }),
    }),
    "conversations.history": ({
      snapshot,
      offset = 0,
      limit = 50,
      ...ref
    }: ServerConversationOperations["conversations.history"]["params"]) => {
      const conversation = resolve(ref)
      for (const [token, page] of pages)
        if (page.expires <= now() || page.generation !== deps.generation()) pages.delete(token)
      let page = snapshot ? pages.get(snapshot) : undefined
      if (
        snapshot &&
        (!page || page.ref.conversationId !== ref.conversationId || page.ref.incarnation !== ref.incarnation)
      )
        throw stale()
      if (!page) {
        const projected = deps.historyCut(ref, () => {
          if (conversation) return nativeConversationHistory(conversation)
          const messages = deps.control.subagentMessages(ref.conversationId)
          if (!messages) throw stale()
          return copyHistory(messages)
        })
        const cut = freezeSnapshot(frontendJson(projected.cut)) as unknown as ServerConversationCut
        const bytes = projected.history.bytes + Buffer.byteLength(JSON.stringify(cut))
        if (bytes > 32 * 1024 * 1024)
          throw new FrontendOperationError(
            "operation_failed",
            "Conversation history exceeds the snapshot limit",
          )
        page = {
          ref,
          generation: deps.generation(),
          expires: now() + 60_000,
          ...projected.history,
          cut,
          bytes,
        }
        snapshot = crypto.randomUUID()
        while (
          pages.size >= 4 ||
          [...pages.values()].reduce((sum, cached) => sum + cached.bytes, page.bytes) > 32 * 1024 * 1024
        )
          pages.delete(pages.keys().next().value!)
        pages.set(snapshot, page)
      }
      const end = historyPageEnd(page.sizes, offset, limit)
      return {
        ...page.cut,
        snapshot: snapshot!,
        sessionGeneration: page.generation,
        messages: page.messages.slice(offset, end),
        ...(end < page.messages.length ? { nextOffset: end } : {}),
      }
    },
    "conversations.focus": (ref: ServerConversationRef) => {
      resolve(ref)
      deps.onFocus?.(ref)
      return { ...ref, sessionGeneration: deps.generation() }
    },
    "conversations.unfocus": () => {
      deps.onFocus?.(null)
      return { sessionGeneration: deps.generation() }
    },
    "conversations.control": (params: ServerConversationOperations["conversations.control"]["params"]) => {
      resolve({ conversationId: params.conversationId })
      const accepted =
        params.action === "message"
          ? deps.control.messageSubagent(params.conversationId, params.text)
          : params.action === "pause"
            ? deps.control.pauseSubagent(params.conversationId)
            : params.action === "resume"
              ? deps.control.resumeSubagent(params.conversationId)
              : deps.control.stopSubagent(params.conversationId)
      return { accepted, sessionGeneration: deps.generation() }
    },
  }
  return {
    handlers,
    bind(conversation: OwnedConversation) {
      const incarnation = conversationIncarnation(conversation)
      if (!isConversationIncarnation(conversation, incarnation)) throw stale()
      const binding = { conversation, generation: deps.generation() }
      owned.set(conversation.id, binding)
      return Object.assign(
        () => {
          if (owned.get(conversation.id) === binding) owned.delete(conversation.id)
        },
        { incarnation },
      )
    },
    includes(ref: ServerConversationRef, id: string): boolean {
      const conversation = resolve(ref)
      if (conversation) return conversationScopeContains(conversation, id)
      const parents = new Map(deps.control.subagents().map((child) => [child.id, child.parentSessionId]))
      const seen = new Set<string>()
      for (
        let current: string | undefined = id;
        current && !seen.has(current);
        current = parents.get(current)
      ) {
        if (current === ref.conversationId) return true
        seen.add(current)
      }
      return false
    },
    ownedScope(id: string): OwnedConversation | undefined {
      const binding = owned.get(id)
      if (!binding || binding.generation !== deps.generation()) return undefined
      const incarnation = conversationIncarnation(binding.conversation)
      return isConversationIncarnation(binding.conversation, incarnation) ? binding.conversation : undefined
    },
    clear() {
      owned.clear()
      pages.clear()
    },
  }
}
