import type { Agent } from "../agent.ts"
import type { Admission, AdmissionWork } from "./scheduler.ts"

/** Root admission shares permits, not descendant ownership or usage receipts. */
export async function runRoot<T>(options: {
  agent: Agent
  task: () => Promise<T>
  signal: AbortSignal
  admission: Admission
  roots: Set<AbortController>
  spent: () => string | undefined
}): Promise<T> {
  const { agent, task, signal, admission, roots, spent } = options
  signal.throwIfAborted()
  if (spent()) throw new Error(`the agent tree's budget is spent (${spent()})`)
  const work: AdmissionWork = {
    id: agent.sessionId,
    parentSessionId: agent.parentSessionId ?? "host",
    agent,
    groups: [],
    ephemeral: true,
    admitted: false,
    waiting: undefined,
  }
  const abort = new AbortController()
  const turnSignal = AbortSignal.any([signal, abort.signal])
  roots.add(abort)
  const previous = agent.execution.onTools
  const stop = () => agent.abort()
  let installed = false
  try {
    await admission.acquire(work, turnSignal)
    turnSignal.throwIfAborted()
    if (spent()) throw new Error(`the agent tree's budget is spent (${spent()})`)
    turnSignal.addEventListener("abort", stop, { once: true })
    agent.execution.onTools = {
      waiting: () => admission.beginTools(work),
      returned: () => admission.endTools(work),
      ready: (signal) => admission.reenter(work, AbortSignal.any([signal, turnSignal])),
    }
    installed = true
    return await task()
  } finally {
    turnSignal.removeEventListener("abort", stop)
    if (installed) agent.execution.onTools = previous
    roots.delete(abort)
    admission.release(work)
    admission.admit()
  }
}
