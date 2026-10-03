import type { AnyEvent } from "@amira/api"
import type { Agent } from "../agent.ts"
import type { EmitMeta } from "../event-bus.ts"
import type { Child } from "./child.ts"

/** A parent's ids without its turn: a child can end after the turn that started it. */
export function parentMeta(parent: Agent): EmitMeta {
  const meta: EmitMeta = { sessionId: parent.sessionId }
  if (parent.parentSessionId) meta.parentSessionId = parent.parentSessionId
  return meta
}

export function metaOf(agent: Agent): EmitMeta {
  const meta: EmitMeta = { sessionId: agent.sessionId }
  if (agent.parentSessionId) meta.parentSessionId = agent.parentSessionId
  if (agent.turnId) meta.turnId = agent.turnId
  return meta
}

/** Follows a child and its descendants until its end, subscribing when iteration starts. */
export function followChild(child: Child): AsyncIterator<AnyEvent> {
  const queue: AnyEvent[] = []
  // Descendants join as their subagent.start comes by, which is before any of their events.
  const members = new Set([child.id])
  let ended = child.state === "ended"
  let wake: (() => void) | undefined
  const off = ended
    ? () => {}
    : child.agent.bus.subscribe((e) => {
        if (ended) return
        const end = e.type === "subagent.end" && e.data.childSessionId === child.id
        const own = e.type === "subagent.state" && e.data.childSessionId === child.id
        if (!end && !own && !members.has(e.sessionId)) return
        if (e.type === "subagent.start") members.add(e.data.childSessionId)
        queue.push(e)
        if (end) {
          ended = true
          off()
        }
        wake?.()
      })
  return {
    async next() {
      while (true) {
        const e = queue.shift()
        if (e) return { value: e, done: false }
        if (ended) return { value: undefined, done: true }
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        wake = undefined
      }
    },
    async return() {
      ended = true
      queue.length = 0
      off()
      wake?.()
      return { value: undefined, done: true }
    },
  }
}
