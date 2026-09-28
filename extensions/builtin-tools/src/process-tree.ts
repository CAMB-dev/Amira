import { dlopen, FFIType } from "bun:ffi"
import type { Subprocess } from "bun"

/** Kills a spawned process together with everything it started. */
export interface ProcessTree {
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

const PROCESS_SET_QUOTA_AND_TERMINATE = 0x0101

type Kernel32 = ReturnType<typeof loadKernel32>
let kernel32: Kernel32 | null | undefined

function loadKernel32() {
  return dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    OpenProcess: { args: [FFIType.u32, FFIType.bool, FFIType.u32], returns: FFIType.ptr },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
    TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.bool },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
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

/**
 * MSYS fork emulation breaks the Windows parent chain, so neither child.kill() nor taskkill /T reaches
 * Git Bash grandchildren. A Job Object does: every process started by a job member joins the job.
 * Known gap: the child runs before it is assigned, so anything it spawns in that window escapes the job.
 */
function windowsJobTree(proc: Subprocess): ProcessTree {
  const k = getKernel32()
  const job = k?.CreateJobObjectW(null, null) ?? null
  if (k && job) {
    const handle = k.OpenProcess(PROCESS_SET_QUOTA_AND_TERMINATE, false, proc.pid)
    if (handle) {
      k.AssignProcessToJobObject(job, handle)
      k.CloseHandle(handle)
    }
  }
  let closed = false
  return {
    kill() {
      if (k && job && !closed) k.TerminateJobObject(job, 1)
      proc.kill()
    },
    dispose() {
      if (k && job && !closed) k.CloseHandle(job)
      closed = true
    },
  }
}
