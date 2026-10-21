import { randomUUID } from "node:crypto"
import { statSync } from "node:fs"
import type { Message } from "@amira/ai"
import type { CompactionInfo } from "@amira/api"
import { messageTurnId } from "../agent/message-turn.ts"
import type { Agent } from "../agent.ts"
import { frontendDisplayHistory } from "./display-history.ts"
import { freezeSnapshot, frontendJson } from "./json.ts"
import type { FrontendMessage, FrontendSnapshot, FrontendTranscript } from "./snapshot.ts"

// Fileless identities survive frontend detach/recreation without retaining disposed agents.
const sessionIdentities = new WeakMap<Agent, WeakMap<Message, string>>()

export function localSnapshotProjector(agent: Agent) {
  let identities = sessionIdentities.get(agent)
  if (!identities) {
    identities = new WeakMap()
    sessionIdentities.set(agent, identities)
  }
  const messageIds = identities
  let copies = new WeakMap<Message, FrontendMessage>()
  let source: Message[] = []
  let revision = -1
  let leaf: string | null | undefined
  let title: string | undefined
  let updatedAt: number | undefined
  let transcript: FrontendTranscript | undefined
  let previous: FrontendSnapshot | undefined

  return (sessionGeneration: number, invalidate: boolean | string = false): FrontendSnapshot => {
    const nextRevision = agent.session?.entries.length ?? 0
    const nextLeaf = agent.session?.leafId
    const storeChanged = revision !== nextRevision || leaf !== nextLeaf
    const historyChanged =
      invalidate !== false ||
      !transcript ||
      storeChanged ||
      source.length !== agent.messages.length ||
      source.some((message, i) => message !== agent.messages[i])
    if (invalidate === true) copies = new WeakMap()
    else if (typeof invalidate === "string") {
      // Before-call interceptors may mutate the live history arguments after message.end.
      const message = agent.messages.findLast(
        (message) =>
          message.role === "assistant" &&
          message.content.some((block) => block.type === "toolCall" && block.id === invalidate),
      )
      if (message) copies.delete(message)
    }
    if (historyChanged) {
      const branch = agent.session?.branch() ?? []
      const times = new Map(branch.filter((entry) => entry.type === "message").map((e) => [e.id, e.ts]))
      const messages = agent.messages.map((message) => {
        const entryId = agent.entryId(message)
        // A compaction entry owns both a user summary and an assistant acknowledgement.
        let id = entryId ? `${entryId}:${message.role}` : messageIds.get(message)
        if (!id) {
          id = `local:${agent.sessionId}:${randomUUID()}`
          messageIds.set(message, id)
        }
        let copy = copies.get(message)
        if (!copy) {
          copy = freezeSnapshot(frontendJson(message) as FrontendMessage)
          copies.set(message, copy)
        }
        const ts = entryId ? times.get(entryId) : undefined
        if (ts !== undefined) frontendJson(ts)
        const compaction = agent.compactionInfo(message)
        const turnId = messageTurnId(message)
        return {
          id,
          ...(entryId !== undefined ? { entryId } : {}),
          ...(turnId !== undefined ? { turnId } : {}),
          message: copy,
          ...(ts !== undefined ? { ts } : {}),
          ...(compaction ? { compaction: frontendJson(compaction) as unknown as CompactionInfo } : {}),
        }
      })
      transcript = freezeSnapshot({ messages, displays: frontendDisplayHistory(agent) })
      source = [...agent.messages]
    }
    if (storeChanged) {
      title = agent.session?.title
      updatedAt = undefined
      try {
        if (agent.session?.file && (transcript!.messages.length || transcript!.displays.length)) {
          updatedAt = statSync(agent.session.file).mtimeMs
        }
      } catch {}
    }
    revision = nextRevision
    leaf = nextLeaf
    const thinking = agent.thinking.state(agent.model).thinking
    const state = {
      sessionId: agent.sessionId,
      cwd: agent.cwd,
      ...(title !== undefined ? { title } : {}),
      resumed: transcript!.messages.length > 0 || transcript!.displays.length > 0,
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      status: agent.status,
      model: {
        provider: agent.model.provider,
        id: agent.model.id,
        contextWindow: agent.model.contextWindow,
        caps: { images: agent.model.caps.images },
      },
      ...(agent.turnId ? { turnId: agent.turnId } : {}),
      ...(agent.holdId ? { holdId: agent.holdId } : {}),
      permissionMode: agent.permissions.mode,
      ...(thinking !== undefined ? { thinking } : {}),
      fastMode: { requested: agent.fastMode, applied: agent.fastModeApplied },
      ...(agent.contextTokens !== undefined ? { contextTokens: agent.contextTokens } : {}),
      children: agent.tree?.children.length ?? 0,
    }
    frontendJson(state) // Validate numeric metadata as well as opaque message payloads.
    if (
      previous &&
      previous.transcript === transcript &&
      JSON.stringify(previous.state) === JSON.stringify(state)
    ) {
      return previous
    }
    previous = freezeSnapshot({ sessionGeneration, state, transcript: transcript! })
    return previous
  }
}
