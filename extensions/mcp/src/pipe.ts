// A long-lived child process with piped stdio. Runs inside the pipe worker (see stdio.ts),
// or on the calling thread when workers are unavailable.

export interface PipeSpec {
  argv: string[]
  cwd: string
  env: Record<string, string>
}

export type PipeEvent =
  | { type: "spawned"; pid: number }
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; code: number | null; error?: string }

/** Main thread → pipe worker. */
export type ToPipeWorker =
  | { type: "open"; spec: PipeSpec }
  | { type: "write"; data: string }
  | { type: "close"; graceMs: number }

/** Pipe worker → main thread; "ready" tells a load failure apart from a crash. */
export type FromPipeWorker = { type: "ready" } | PipeEvent

export interface PipeHandle {
  write(data: string): void
  /** Ends stdin, then kills the process tree if it has not exited after `graceMs`. */
  close(graceMs: number): void
}

export function openPipe(spec: PipeSpec, emit: (e: PipeEvent) => void): PipeHandle {
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
  if (process.platform === "win32") {
    try {
      Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
    } catch {}
  }
  try {
    proc.kill("SIGKILL")
  } catch {}
}
