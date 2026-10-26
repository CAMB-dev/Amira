/**
 * Windows CI/antivirus can stall each spawn for several seconds. Give process tests
 * room for startup, the original operation budget, and awaited cleanup (some
 * fixtures have several 30s rendezvous). This is a hang guard, not permission to
 * increase an operation's latency assertion.
 */
export const SPAWN_TEST_TIMEOUT_MS = 180_000
export const SPAWN_WAIT_TIMEOUT_MS = 30_000
/**
 * For awaiting the real end of a fixture that spawns several processes in a row (a job's
 * tree, a nested test run): its own end is the event, so only the test's hang guard bounds
 * it, less room for the awaited cleanup. A fixed 30s stage budget fails under full-suite load.
 */
export const SPAWN_EVENT_TIMEOUT_MS = SPAWN_TEST_TIMEOUT_MS - SPAWN_WAIT_TIMEOUT_MS

type Child = Pick<Bun.Subprocess, "pid" | "exitCode" | "exited">

/** Observe an event using a monotonic clock, rather than estimating completion with sleeps. */
export async function waitForSpawnCondition(
  label: string,
  condition: () => boolean,
  timeoutMs = SPAWN_WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(`${label} timed out after ${timeoutMs}ms`)
    await Bun.sleep(10)
  }
}

/** Bound stream drains and other async fixture work as well as process exit. */
export async function waitForSpawnWork<T>(
  label: string,
  work: Promise<T>,
  timeoutMs = SPAWN_WAIT_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function waitForSpawnExit(
  child: Child,
  label: string,
  timeoutMs = SPAWN_WAIT_TIMEOUT_MS,
): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exit timed out after ${timeoutMs}ms (pid ${child.pid})`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Give the owned child a bounded grace period, then force-kill and reap it. */
export async function stopSpawn(
  child: Child & Pick<Bun.Subprocess, "kill">,
  label = "child cleanup",
  graceMs = 1000,
) {
  try {
    if (child.exitCode === null) {
      try {
        child.kill("SIGTERM")
        await waitForSpawnExit(child, `${label} graceful shutdown`, graceMs)
      } catch {
        if (child.exitCode === null) child.kill("SIGKILL")
      }
    }
  } finally {
    await waitForSpawnExit(child, label)
  }
}
