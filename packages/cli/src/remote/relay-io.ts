import { RemoteError, RemoteReplyError } from "./errors.ts"
import { sshExitError } from "./reconnect-failure.ts"
import type { SshSession } from "./ssh.ts"

type Exit = { code: number } | { error: unknown }
const observed = new WeakMap<SshSession, SshSession>()

/** Reconcile unexpected EOF/write failure before generic transport closure loses process diagnostics. */
export function observeSshRelay(session: SshSession, options: { exitGraceMs?: number } = {}): SshSession {
  const previous = observed.get(session)
  if (previous) return previous
  const grace = options.exitGraceMs ?? 1000
  if (!Number.isInteger(grace) || grace < 0 || grace > 5000) throw new Error("Invalid SSH exit grace")
  const closing = new AbortController()
  let exit: Exit | undefined
  let exitTimer: ReturnType<typeof setTimeout> | undefined
  let rawClosed = false
  const closeRaw = () => {
    if (rawClosed) return
    rawClosed = true
    session.close()
  }
  const terminated = (outcome: Exit) => {
    exit = outcome
    // Inherited pipes must not hide a proven process exit. Drain queued protocol bytes
    // briefly first, so a validated rejection still wins over process diagnostics.
    if (!closing.signal.aborted) exitTimer = setTimeout(closeRaw, grace)
  }
  const status = session.exitStatus ?? session.exited
  void status.then(
    (code) => terminated({ code }),
    (error) => terminated({ error }),
  )
  const drained = session.exited.then(
    (code) => {
      exit ??= { code }
    },
    (error) => {
      exit ??= { error }
    },
  )
  void drained.then(() => clearTimeout(exitTimer))
  async function failure(cause?: unknown): Promise<unknown> {
    if (closing.signal.aborted) return undefined
    if (cause instanceof RemoteReplyError || (cause instanceof RemoteError && cause.code !== "disconnected"))
      return cause
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort = () => {}
    try {
      await Promise.race([
        drained,
        new Promise<void>((resolve) => {
          abort = resolve
          closing.signal.addEventListener("abort", abort, { once: true })
          timer = setTimeout(resolve, grace)
        }),
      ])
    } finally {
      clearTimeout(timer)
      closing.signal.removeEventListener("abort", abort)
    }
    if (closing.signal.aborted) return undefined
    if (exit && "error" in exit) return exit.error
    if (exit && "code" in exit) {
      const error = sshExitError(exit.code, session.stderr(), "relay")
      if (error) return error
    }
    return cause || !exit ? new RemoteError("disconnected", "Remote SSH transport interrupted") : undefined
  }
  const relay: SshSession = {
    input: {
      async *[Symbol.asyncIterator]() {
        let cause: unknown
        try {
          yield* session.input
        } catch (error) {
          cause = error
        }
        const error = await failure(cause)
        if (error) throw error
      },
    },
    async write(bytes) {
      try {
        await session.write(bytes)
      } catch (cause) {
        throw (await failure(cause)) ?? cause
      }
    },
    end: (bytes) => session.end(bytes),
    close() {
      if (closing.signal.aborted) return
      closing.abort()
      clearTimeout(exitTimer)
      closeRaw()
    },
    exitStatus: session.exitStatus,
    exited: session.exited,
    stderr: () => session.stderr(),
  }
  observed.set(session, relay)
  observed.set(relay, relay)
  return relay
}
