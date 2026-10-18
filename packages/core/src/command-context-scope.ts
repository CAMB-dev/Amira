import { AsyncLocalStorage } from "node:async_hooks"
import type { CommandContext } from "@amira/api"
import { bindCommandViewContext, registerCommandViewContext } from "./command-view-context.ts"
import type { CommandRunOptions } from "./commands.ts"

interface Invocation {
  generation: number
}

interface Transition {
  owner: Invocation
  active: boolean
  controller: AbortController
}

const TRANSITIONS = new Set<PropertyKey>(["newSession", "resume", "fork", "rewind"])

/** Monotonic host authority, with adoption limited to a control's own transition chain. */
export class CommandContextScope {
  #generation = 0
  #transition = new AsyncLocalStorage<Transition | undefined>()
  #active = new Set<Transition>()
  #dialogs = new Set<{ generation: number; controller: AbortController }>()

  /** A nested command, skill or input handler never inherits its caller's transition. */
  run<T>(run: () => T): T {
    return this.#transition.run(undefined, run)
  }

  switched(notify: () => void): void {
    const transition = this.#transition.getStore()
    const previous = this.#generation++
    if (transition?.active && transition.owner.generation === previous) {
      transition.owner.generation = this.#generation
    }
    for (const pending of this.#active)
      if (pending.owner.generation !== this.#generation) pending.controller.abort()
    for (const dialog of this.#dialogs) if (dialog.generation !== this.#generation) dialog.controller.abort()
    // A listener starting another switch is not part of the committed owner's transition.
    this.run(notify)
  }

  capture(signal?: AbortSignal) {
    const owner: Invocation = { generation: this.#generation }
    const current = () => owner.generation === this.#generation && !signal?.aborted
    const check = () => {
      signal?.throwIfAborted()
      if (!current()) throw new Error("command context is no longer current")
    }
    const transition = async (key: PropertyKey, run: () => unknown, args: unknown[]) => {
      const claim: Transition = { owner, active: true, controller: new AbortController() }
      const index = key === "newSession" ? 0 : 1
      const options = args[index] as { signal?: AbortSignal } | undefined
      args[index] = {
        ...options,
        signal: AbortSignal.any([
          claim.controller.signal,
          ...(signal ? [signal] : []),
          ...(options?.signal ? [options.signal] : []),
        ]),
      }
      this.#active.add(claim)
      try {
        return await this.#transition.run(claim, run)
      } finally {
        // Async descendants can outlive a transition, but must not retain its authority.
        claim.active = false
        this.#active.delete(claim)
      }
    }
    return {
      current,
      view: (open: NonNullable<CommandContext["openView"]>, frontendCurrent = () => true) => {
        const bind = (currentRoot: () => boolean) => {
          const available = () => currentRoot() && frontendCurrent()
          const bound = bindCommandViewContext(open, available)
          return (view: Parameters<typeof open>[0]) => available() && bound(view)
        }
        return registerCommandViewContext(bind(current), bind)
      },
      control: <T extends object>(target: T, onSend?: CommandRunOptions["onSend"]): T =>
        guard(target, check, (key, run, args) => {
          if (TRANSITIONS.has(key)) return transition(key, run, args)
          if (key !== "send" || !onSend) return run()
          return sendWithEcho(run, onSend, args, check)
        }),
      // UiApi promises always resolve, including a dialog requested from an obsolete context.
      ui: <T extends object>(target: T): T =>
        guard(
          target,
          () => {},
          (key, run, args) => {
            if (!current()) return Promise.resolve(undefined)
            const dialog = { generation: this.#generation, controller: new AbortController() }
            const index = key === "select" || key === "choose" || key === "confirm" ? 2 : 1
            const options = args[index] as { signal?: AbortSignal } | undefined
            args[index] = {
              ...options,
              signal: AbortSignal.any([
                dialog.controller.signal,
                ...(signal ? [signal] : []),
                ...(options?.signal ? [options.signal] : []),
              ]),
            }
            this.#dialogs.add(dialog)
            try {
              return Promise.resolve(run()).finally(() => this.#dialogs.delete(dialog))
            } catch (error) {
              this.#dialogs.delete(dialog)
              throw error
            }
          },
        ),
    }
  }
}

type Invoke = (key: PropertyKey, run: () => unknown, args: unknown[]) => unknown

/** Guard both property reads and retained methods, including nested admin/data capabilities.
 * Returned snapshots and owned resources retain their existing session attribution.
 */
function guard<T extends object>(target: T, check: () => void, invoke?: Invoke): T {
  const nested = new WeakMap<object, object>()
  const wrap = (object: object, root: boolean): object => {
    const existing = nested.get(object)
    if (existing) return existing
    // Forward through an empty target so frozen capability objects can also be wrapped.
    const proxy = new Proxy(
      {},
      {
        get: (_target, key) => {
          check()
          const value: unknown = Reflect.get(object, key)
          if (typeof value === "function") {
            return (...args: unknown[]) => {
              check()
              const run = () => Reflect.apply(value, object, args)
              return root && invoke ? invoke(key, run, args) : run()
            }
          }
          return value && typeof value === "object" ? wrap(value, false) : value
        },
        ownKeys: () => {
          check()
          return Reflect.ownKeys(object)
        },
        getOwnPropertyDescriptor: (_target, key) => {
          check()
          const descriptor = Reflect.getOwnPropertyDescriptor(object, key)
          return descriptor ? { enumerable: descriptor.enumerable, configurable: true } : undefined
        },
        has: (_target, key) => {
          check()
          return Reflect.has(object, key)
        },
      },
    )
    nested.set(object, proxy)
    return proxy
  }
  return wrap(target, true) as T
}

async function sendWithEcho(
  run: () => unknown,
  onSend: NonNullable<CommandRunOptions["onSend"]>,
  args: unknown[],
  check: () => void,
) {
  const [text, options] = args as Parameters<NonNullable<CommandRunOptions["onSend"]>>
  const failed = onSend(text, options)
  try {
    check()
    await run()
  } catch (error) {
    failed?.()
    throw error
  }
}
