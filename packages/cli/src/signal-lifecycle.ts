import { constants } from "node:os"

interface SignalLifecycleOptions {
  stopUpdates(): Promise<void>
  restoreTerminal(): void | Promise<void>
}

/** Application-owned termination: keep terminal fallbacks from exiting during an executable swap. */
export function createSignalLifecycle(options: SignalLifecycleOptions) {
  let closing: Promise<void> | undefined
  let sigintDelegates = 0
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]
  if (process.platform === "win32") signals.push("SIGBREAK")

  function exit(code: number): Promise<void> {
    if (closing) return closing
    const completion = Promise.withResolvers<void>()
    closing = completion.promise
    void (async () => {
      // stop() fences future activation synchronously, then drains a started local transaction.
      try {
        await options.stopUpdates()
      } catch {}
      try {
        await options.restoreTerminal()
      } catch {}
      for (const { signal, handler } of handlers) process.off(signal, handler)
      process.exit(code)
    })().then(completion.resolve, completion.reject)
    return closing
  }

  const handlers = signals.map((signal) => {
    const handler = () => {
      // runPrint's first Ctrl+C interrupts its turn. Its second Ctrl+C uses the app's forceExit.
      if (signal === "SIGINT" && sigintDelegates > 0) return
      void exit(128 + (constants.signals[signal] ?? 0))
    }
    process.on(signal, handler)
    return { signal, handler }
  })

  return {
    exit,
    async delegateSigint<T>(run: () => Promise<T>): Promise<T> {
      sigintDelegates++
      try {
        return await run()
      } finally {
        sigintDelegates--
      }
    },
  }
}
