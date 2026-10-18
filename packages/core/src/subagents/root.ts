import type { Agent } from "../agent.ts"
import { overBudget } from "./budget.ts"
import { scopeAdmission } from "./lifecycle.ts"
import type { Admission, AdmissionWork } from "./scheduler.ts"

/** Side admission reserves a physical permit without taking over an active turn's hooks. */
export async function runSide<T>(options: {
  agent: Agent
  task: (signal: AbortSignal) => Promise<T>
  signal: AbortSignal
  admission: Admission
  roots: Set<AbortController>
}): Promise<T> {
  const { agent, task, signal, admission, roots } = options
  const tree = agent.tree!
  const abort = new AbortController()
  const requestSignal = AbortSignal.any([signal, abort.signal])
  const work: AdmissionWork = {
    id: `side:${agent.sessionId}`,
    parentSessionId: agent.sessionId,
    agent,
    groups: [],
    ephemeral: true,
    admitted: false,
    waiting: undefined,
  }
  const check = () => {
    requestSignal.throwIfAborted()
    scopeAdmission(tree).check(agent.sessionId)
    const spent = tree.budgetExceeded ?? overBudget(tree.usage, tree.budget)
    if (spent) throw new Error(`the agent tree's budget is spent (${spent})`)
  }
  roots.add(abort)
  try {
    check()
    await admission.acquire(work, requestSignal)
    check()
    return await task(requestSignal)
  } finally {
    roots.delete(abort)
    admission.release(work)
    admission.admit()
  }
}

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
