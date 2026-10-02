import type { EventBus, TraceRecorder } from "@amira/core"

/**
 * Host-only shutdown: let queued events reach the recorder, then finish its appends.
 * A stuck extension or filesystem cannot hold exit forever. The recorder's process-exit
 * hook handles buffered records left after either deadline; it cannot recover queued events.
 */
export async function closeTrace(
  bus: Pick<EventBus, "flush">,
  trace: Pick<TraceRecorder, "close"> | undefined,
  timeoutMs = 1000,
): Promise<void> {
  if (!trace) return
  try {
    await Promise.race([bus.flush(), Bun.sleep(timeoutMs)])
    await Promise.race([trace.close(), Bun.sleep(timeoutMs)])
  } catch {
    // Observability must not turn a successful session into a failed process exit.
  }
}
