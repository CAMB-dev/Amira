// POSIX-only tooling entry point. The real CLI cannot run until its independent watchdog is armed.
if (import.meta.main) {
  const terminate = () => {
    try {
      process.kill(-process.pid, "SIGKILL")
    } catch {
      process.exit(1)
    }
  }
  process.on("disconnect", terminate)
  await new Promise<void>((resolve) => {
    const timer = setTimeout(terminate, 10_000)
    process.on("message", (message) => {
      if (message === "ui-walk-start") {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  await import("../../packages/cli/src/main.ts")
}
