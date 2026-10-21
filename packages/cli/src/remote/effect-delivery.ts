import type { RemoteAgentPort } from "./agent-port.ts"
import { RemoteError } from "./errors.ts"

/** Replies may overtake a backpressured journal pump; retain invocation callbacks until its effects apply. */
export async function waitForRemoteEffects(
  port: RemoteAgentPort,
  epoch: string,
  through: number,
  signal?: AbortSignal,
): Promise<void> {
  const applied = () => port.cursor?.daemonEpoch === epoch && port.cursor.after >= through
  if (applied()) return
  await new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => {
      for (const off of subscriptions) off()
      signal?.removeEventListener("abort", abort)
      if (error) reject(error)
      else resolve()
    }
    const check = () => {
      if (applied()) done()
      else if (port.cursor?.daemonEpoch !== epoch || port.connection === "disconnected")
        done(
          new RemoteError(
            "disconnected",
            "The command completed remotely before its frontend effects were delivered",
          ),
        )
    }
    const abort = () => done(new RemoteError("cancelled", "Command presentation cancelled"))
    const later = () => queueMicrotask(check) // The replay cursor advances after listeners finish applying.
    const subscriptions = [
      port.subscribeWorkspace(later),
      port.subscribeReset(later),
      port.subscribeConnection(check),
    ]
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    else check()
  })
}
