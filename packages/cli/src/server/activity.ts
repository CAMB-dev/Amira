import type { Ai, StreamEvent } from "@amira/ai"
import type { Agent } from "@amira/core"
import { heldInputSnapshot, holdStateSnapshot } from "../../../core/src/agent/held-input.ts"
import {
  noticeInputAgents,
  noticeInputSnapshot,
  steeringInputSnapshot,
} from "../../../core/src/agent/notice-input.ts"

/** Includes side calls (titles, summaries and native compaction), not only root turns. */
export function trackRuntimeAi(ai: Ai, changed: () => void = () => {}) {
  let pending = 0
  const operations: Pick<Ai, "stream" | "compact"> = {
    stream(request, signal) {
      return {
        [Symbol.asyncIterator]() {
          const iterator = ai.stream(request, signal)[Symbol.asyncIterator]()
          let started = false
          let finished = false
          const finish = () => {
            if (finished) return
            finished = true
            if (started) {
              pending--
              changed()
            }
          }
          const forward = async (operation: () => Promise<IteratorResult<StreamEvent>>) => {
            try {
              const result = await operation()
              if (result.done) finish()
              return result
            } catch (error) {
              finish()
              throw error
            }
          }
          // Do not queue return/throw behind next: proxy iterators cancel before awaiting cleanup.
          return {
            next(...args) {
              if (!started && !finished) {
                started = true
                pending++
                changed()
              }
              return forward(() => iterator.next(...args))
            },
            return(value) {
              return forward(() => iterator.return?.(value) ?? Promise.resolve({ done: true, value }))
            },
            throw(error) {
              return forward(async () => {
                if (iterator.throw) return iterator.throw(error)
                await iterator.return?.()
                throw new TypeError("The stream iterator does not provide a throw method")
              })
            },
          }
        },
      }
    },
    async compact(...args) {
      pending++
      changed()
      try {
        return await ai.compact(...args)
      } finally {
        pending--
        changed()
      }
    },
  }
  const tracked = new Proxy(ai, {
    get(target, key) {
      if (key === "stream" || key === "compact") return operations[key]
      return Reflect.get(target, key, target)
    },
  })
  return { ai: tracked, pending: () => pending }
}

/** Read live host state, never a possibly degraded transport projection. */
export function ownerHasWork(root: Agent): boolean {
  return [root, ...noticeInputAgents(root.bus)].some((agent) => {
    const notices = noticeInputSnapshot(agent)
    return (
      agent.busy ||
      holdStateSnapshot(agent) !== null ||
      heldInputSnapshot(agent).length > 0 ||
      steeringInputSnapshot(agent).length > 0 ||
      notices.queue.length > 0 ||
      notices.expected > 0 ||
      agent.noticeRetry !== undefined
    )
  })
}
