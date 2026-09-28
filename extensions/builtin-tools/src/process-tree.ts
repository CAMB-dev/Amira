import { dlopen, FFIType, ptr } from "bun:ffi"
import type { Subprocess } from "bun"

/** Kills a spawned process together with everything it started. */
export interface ProcessTree {
  /**
   * False when the process could not be placed in a Job Object (Windows only). kill() then falls back
   * to taskkill /T, which cannot reach MSYS grandchildren, so some processes may survive.
   */
  readonly contained: boolean
  kill(): void
  /** Releases OS handles. Call once the process has exited and been killed. */
  dispose(): void
}

export function trackProcessTree(proc: Subprocess): ProcessTree {
  return process.platform === "win32" ? windowsJobTree(proc) : posixGroupTree(proc)
}

/** Requires the child to have been spawned with `detached: true`, which makes it a process group leader. */
function posixGroupTree(proc: Subprocess): ProcessTree {
  return {
    contained: true,
    kill() {
      try {
        process.kill(-proc.pid, "SIGKILL")
      } catch {
        proc.kill("SIGKILL")
      }
    },
    dispose() {},
  }
}

const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

type Kernel32 = ReturnType<typeof loadKernel32>
let kernel32: Kernel32 | null | undefined

// HANDLE is a pointer, DWORD is u32 and BOOL is a 32-bit int.
function loadKernel32() {
  return dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IsProcessInJob: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  }).symbols
}

function getKernel32(): Kernel32 | null {
  if (kernel32 === undefined) {
    try {
      kernel32 = loadKernel32()
    } catch {
      kernel32 = null
    }
  }
  return kernel32
}

/** Loads the Win32 bindings ahead of the first command, so the first call does not pay for it. */
export function warmUpProcessTree(): void {
  if (process.platform !== "win32") return
  const k = getKernel32()
  const job = k?.CreateJobObjectW(null, null)
  if (k && job) k.CloseHandle(job)
}

function assignToJob(k: Kernel32, job: NonNullable<ReturnType<Kernel32["CreateJobObjectW"]>>, pid: number) {
  const handle = k.OpenProcess(
    PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
    0,
    pid,
  )
  if (!handle) return false
  try {
    if (k.AssignProcessToJobObject(job, handle) === 0) return false
    const inJob = new Int32Array(1)
    return k.IsProcessInJob(handle, job, ptr(inJob)) !== 0 && inJob[0] !== 0
  } finally {
    k.CloseHandle(handle)
  }
}

/**
 * MSYS fork emulation breaks the Windows parent chain, so neither child.kill() nor taskkill /T reaches
 * Git Bash grandchildren. A Job Object does: every process started by a job member joins the job.
 * Only processes started after assignment are caught, so the caller must keep the child from running
 * anything until this returns (see the stdin gate in shell.ts).
 */
function windowsJobTree(proc: Subprocess): ProcessTree {
  const k = getKernel32()
  let job = k?.CreateJobObjectW(null, null) ?? null
  const contained = !!(k && job && assignToJob(k, job, proc.pid))
  if (k && job && !contained) {
    k.CloseHandle(job)
    job = null
  }
  return {
    contained,
    kill() {
      if (k && job) {
        k.TerminateJobObject(job, 1)
        proc.kill()
        return
      }
      // taskkill needs the parent alive to find its children, so kill the parent afterwards.
      try {
        const tk = Bun.spawn(["taskkill", "/T", "/F", "/PID", String(proc.pid)], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          windowsHide: true,
        })
        tk.exited.then(
          () => proc.kill(),
          () => proc.kill(),
        )
      } catch {
        proc.kill()
      }
    },
    dispose() {
      if (k && job) k.CloseHandle(job)
      job = null
    },
  }
}
