// A long-lived child process with piped stdio (e.g. an MCP server). Runs in the command worker,
// next to every other spawn with pipes (see `openPipe` in index.ts), or on the calling thread
// when workers are unavailable.

export interface PipeSpec {
  argv: string[]
  cwd: string
  env: Record<string, string>
}

export type PipeEvent =
  | { type: "spawned"; pid: number }
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  /** The last event. `error`: the process failed to start, or its worker was lost (it may still run). */
  | { type: "exit"; code: number | null; error?: string }

export interface PipeHandle {
  write(data: string): void
  /** Ends stdin, then kills the process tree if it has not exited after `graceMs`. */
  close(graceMs: number): void
}

/**
 * Spawns a piped process on this thread. Frontends should use `openPipe`, which runs it in the
 * command worker: a slow spawn cannot freeze the main thread, and no spawn on another thread
 * can inherit this process's pipes (see `openPipe`).
 */
export function openPipeInline(spec: PipeSpec, emit: (e: PipeEvent) => void): PipeHandle {
  let proc: Bun.Subprocess<"pipe", "pipe", "pipe">
  try {
    proc = Bun.spawn(spec.argv, {
      cwd: spec.cwd,
      env: spec.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
  } catch (err) {
    emit({ type: "exit", code: null, error: err instanceof Error ? err.message : String(err) })
    return { write() {}, close() {} }
  }
  emit({ type: "spawned", pid: proc.pid })
  let exited = false
  const stdout = pump(proc.stdout, (data) => emit({ type: "stdout", data }))
  const stderr = pump(proc.stderr, (data) => emit({ type: "stderr", data }))
  proc.exited.then(async (code) => {
    exited = true
    // Deliver the last output before the exit, but don't wait on pipes a grandchild holds open.
    await Promise.race([Promise.all([stdout, stderr]), Bun.sleep(500)])
    emit({ type: "exit", code })
  })
  return {
    write(data) {
      if (exited) return
      try {
        proc.stdin.write(data)
        proc.stdin.flush()
      } catch {}
    },
    close(graceMs) {
      if (exited) return
      try {
        proc.stdin.end()
      } catch {}
      setTimeout(() => {
        if (!exited) killTree(proc)
      }, graceMs)
    },
  }
}

async function pump(stream: ReadableStream<Uint8Array>, onData: (s: string) => void): Promise<void> {
  const decoder = new TextDecoder()
  try {
    for await (const chunk of stream) onData(decoder.decode(chunk, { stream: true }))
  } catch {}
  const rest = decoder.decode()
  if (rest) onData(rest)
}

/** Launchers such as npx.cmd leave the real server as a grandchild, so kill the whole tree. */
function killTree(proc: Bun.Subprocess) {
  if (process.platform !== "win32") {
    try {
      proc.kill("SIGKILL")
    } catch {}
    return
  }
  // taskkill needs the parent alive to find its children, so kill the parent afterwards.
  // Not spawnSync: it would hold up every other command on this thread.
  try {
    const tk = Bun.spawn(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    })
    const after = () => {
      try {
        proc.kill("SIGKILL")
      } catch {}
    }
    tk.exited.then(after, after)
  } catch {
    try {
      proc.kill("SIGKILL")
    } catch {}
  }
}
