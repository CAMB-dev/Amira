import type { AnyEvent, Message } from "@amira/api"
import type { FrontendConversationSnapshot, FrontendConversationSource } from "@amira/tui"
import type { RemoteOwnerState } from "../remote-schema.ts"
import type { RemoteAgentPort, RemoteEventContext } from "./agent-port.ts"

/** Immutable history cuts followed by contiguous live events, scoped by opaque host-issued IDs. */
export function remoteConversationSource(port: RemoteAgentPort): FrontendConversationSource & {
  scopeForCwd(cwd: string): string | undefined
  dispose(): void
} {
  const scopes = new Map<string, { id: string; generation: number }>()
  const active = new Set<() => void>()
  const parents = new Map<string, string>()
  const contains = (root: string, id: string) => {
    const seen = new Set<string>()
    let current: string | undefined = id
    while (current && !seen.has(current)) {
      if (current === root) return true
      seen.add(current)
      const workspace = port.workspaceSnapshot
      const owner: RemoteOwnerState | undefined = workspace.owners[current]
      current = owner
        ? owner.parentSessionId
        : (workspace.semantic.subagents.find((child) => child.id === current)?.parentSessionId ??
          parents.get(current) ??
          workspace.activity.events.find((event) => event.sessionId === current && event.parentSessionId)
            ?.parentSessionId)
    }
    return false
  }
  // Main requests need ancestry even before the first conversation has been opened.
  const offAncestry = port.subscribeEvents((event) => {
    if (!event.parentSessionId) return
    parents.set(event.sessionId, event.parentSessionId)
    if (parents.size > 4096) parents.delete(parents.keys().next().value!)
  })
  const offAncestryReset = port.subscribeReset(() => parents.clear())
  return {
    containsSession: contains,
    scopeForCwd(cwd) {
      const entry = scopes.get(cwd)
      return entry?.generation === port.sessionGeneration ? entry.id : undefined
    },
    async open({ conversationId, incarnation }, listener) {
      const ref = { conversationId, incarnation }
      const end = new AbortController()
      const sessionGeneration = port.sessionGeneration
      const options = { signal: end.signal, sessionGeneration }
      let snapshot: FrontendConversationSnapshot | undefined
      let watermark: { daemonEpoch: string; seq: number } | undefined
      let buffered: { event: AnyEvent; context: RemoteEventContext }[] = []
      let bufferedBytes = 0
      let loading: Promise<void> | undefined
      let rerun = false
      let closed = false
      const deliver = (event: AnyEvent, context: RemoteEventContext) => {
        if (!contains(ref.conversationId, event.sessionId)) return
        if (!watermark || watermark.daemonEpoch !== port.cursor?.daemonEpoch || context.seq <= watermark.seq)
          return
        listener({ kind: "event", event })
      }
      const offEvents = port.subscribeEvents((event, context) => {
        if (closed || !contains(ref.conversationId, event.sessionId)) return
        if (loading || !snapshot) {
          const bytes = Buffer.byteLength(JSON.stringify(event))
          if (buffered.length >= 20000 || bufferedBytes + bytes > 16 * 1024 * 1024) {
            rerun = true
            buffered = []
            bufferedBytes = 0
          } else {
            buffered.push({ event, context })
            bufferedBytes += bytes
          }
        } else deliver(event, context)
      })
      const read = async () => {
        const listing = await port.request("conversations.list", {}, options)
        const info = listing.conversations.find(
          (item) => item.id === ref.conversationId && item.incarnation === ref.incarnation,
        )
        if (!info) throw new Error("The remote conversation is no longer available")
        const messages: Message[] = []
        let token: string | undefined
        let offset = 0
        let activity: readonly AnyEvent[] = []
        let renderedTurnIds: readonly string[] = []
        do {
          const page = await port.request(
            "conversations.history",
            { ...ref, snapshot: token, offset, limit: 100 },
            options,
          )
          messages.push(...page.messages)
          token = page.snapshot
          watermark = page.watermark
          activity = page.activity.events as AnyEvent[]
          renderedTurnIds = page.renderedTurnIds ?? []
          offset = page.nextOffset ?? -1
        } while (offset >= 0 && !closed)
        if (closed || sessionGeneration !== port.sessionGeneration)
          throw new Error("The active remote session changed")
        scopes.set(info.cwd, { id: info.id, generation: sessionGeneration })
        if (scopes.size > 128) scopes.delete(scopes.keys().next().value!)
        // The owners/list caches can predate first binding or race the history read.
        // Only this immutable cut identifies the root turn safe to control at its watermark.
        const turn = activity.findLast((event) => event.sessionId === info.id && event.type === "turn.start")
        snapshot = {
          ...ref,
          name: info.name,
          cwd: info.cwd,
          messages,
          busy: !!turn,
          turnId: turn?.turnId,
          acceptsImages: info.acceptsImages,
          activity,
          renderedTurnIds,
        }
      }
      const refresh = async () => {
        if (closed) return
        if (loading) {
          rerun = true
          return loading
        }
        loading = read()
          .then(() => {
            if (!closed) {
              listener({ kind: "snapshot", snapshot: snapshot! })
              const retained = buffered.splice(0)
              if (!rerun) for (const item of retained) deliver(item.event, item.context)
              bufferedBytes = 0
            }
          })
          .finally(() => {
            loading = undefined
            if (rerun && !closed) {
              rerun = false
              void refresh().catch(dispose)
            }
          })
        return loading
      }
      const offReset = port.subscribeReset(() => {
        void refresh().catch(dispose)
      })
      const dispose = () => {
        if (closed) return
        closed = true
        end.abort()
        offEvents()
        offReset()
        active.delete(dispose)
        buffered = []
      }
      active.add(dispose)
      try {
        await refresh()
        return {
          get snapshot() {
            return snapshot!
          },
          dispose,
        }
      } catch (error) {
        dispose()
        throw error
      }
    },
    dispose() {
      for (const close of active) close()
      offAncestry()
      offAncestryReset()
      parents.clear()
      scopes.clear()
    },
  }
}
