// Main-local rewind work waits across owned focus, but never across unrelated session replacement.
import { AsyncLocalStorage } from "node:async_hooks"
import { type Agent, frontendIdentity } from "@amira/core"
import { RewindFlow, type RewindFlowDeps } from "./rewind.ts"

type MainRewindDeps = RewindFlowDeps & {
  conversationFocused: () => boolean
  canOpen: () => boolean
  quitting: () => boolean
}

export function createMainRewind(deps: MainRewindDeps) {
  let generation = 0
  type Root = { agent: Agent | undefined; generation: number; frontendGeneration?: number }
  type Operation = { root: Root; current: () => boolean }
  const roots = new WeakMap<() => boolean, Root>()
  const operations = new AsyncLocalStorage<Operation>()
  let activeOperation: Operation | undefined
  let pending: { current: () => boolean; run: () => boolean } | undefined
  let scheduled = false
  let interruptCurrent: (() => boolean) | undefined
  const current = () => {
    const root: Root = {
      agent: deps.agent(),
      generation,
      frontendGeneration:
        deps.port && !deps.agent() ? frontendIdentity(deps.port).sessionGeneration : undefined,
    }
    const check = () =>
      !deps.quitting() &&
      deps.agent() === root.agent &&
      generation === root.generation &&
      (root.frontendGeneration === undefined ||
        frontendIdentity(deps.port!).sessionGeneration === root.frontendGeneration)
    roots.set(check, root)
    return check
  }
  const runOperation = async (check: () => boolean, run: () => Promise<void>) => {
    const root = roots.get(check)
    if (!root || !check()) return
    const operation = { root, current: check }
    activeOperation = operation
    try {
      await operations.run(operation, run)
      // A successful remote mutation owns its acknowledged snapshot replacement.
      if (!root.agent && deps.port) root.frontendGeneration = frontendIdentity(deps.port).sessionGeneration
    } finally {
      if (activeOperation === operation) activeOperation = undefined
    }
  }
  const onMain = (run: () => boolean): boolean => {
    if (deps.quitting()) return false
    if (!deps.conversationFocused()) return run()
    if (pending?.current()) return false
    pending = { current: current(), run }
    deps.view.notice(
      "info",
      `Rewind is waiting on main. Press ${deps.keys.label("view.focus") ?? "F6"} to return.`,
    )
    deps.redraw()
    return false
  }
  const flow = new RewindFlow({ ...deps, onMain, current, runOperation })
  const canRewind = () =>
    deps.commands?.control.rewind !== undefined ||
    (!deps.agent() && !!deps.port && deps.port.supportedOperations?.includes("session.rewind") !== false)
  return {
    canRewind,
    openRewind: () => flow.openRewind(),
    /** Outbox calls this at the double press, before abort finishes asynchronously. */
    canInterruptRewind() {
      interruptCurrent = current()
      return canRewind()
    },
    openInterruptRewind: () => (interruptCurrent?.() ? flow.openRewind() : false),
    get attention() {
      return pending?.current() ? 1 : 0
    },
    /** The microtask runs after draft restoration and the focus transition's guard. */
    flush() {
      if (scheduled || !pending || deps.conversationFocused()) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        const work = pending
        if (!work) return
        if (!work.current()) {
          pending = undefined
          return
        }
        if (
          deps.conversationFocused() ||
          !deps.canOpen() ||
          deps.working() ||
          deps.compacting() ||
          deps.dialogs.length
        )
          return
        pending = undefined
        work.run()
        deps.redraw()
      })
    },
    reset(next: Agent) {
      // Only the still-current control call can adopt its own synchronous host switch.
      // An unrelated switch invalidates it, even if both replacements share a session ID.
      const operation = operations.getStore()
      const owned = operation === activeOperation && operation?.current()
      generation++
      if (owned && operation) {
        operation.root.agent = next
        operation.root.generation = generation
      }
      pending = undefined
      interruptCurrent = undefined
    },
  }
}
