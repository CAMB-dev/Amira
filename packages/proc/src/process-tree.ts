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
  /**
   * Asks the whole tree to stop: SIGTERM to the process group on POSIX. Returns false where
   * there is no such request (Windows: console programs without a console window get no
   * signal Amira could send), so the caller kills instead.
   */
  terminate(): boolean
  /** Releases OS handles. Call once the process has exited and been killed. */
  dispose(): void
  /**
   * Windows: the Job Object's handle, valid on every thread of this process. When the thread
   * that owns this tree is lost (a worker that stopped), another thread can still end the
   * tree with it (terminateJobHandle).
   */
  readonly jobHandle?: number
}

/**
 * Kills every process in a Job Object and closes its handle, from any thread of this process:
 * for trees whose owning worker was lost. Windows only; elsewhere it does nothing.
 */
export function terminateJobHandle(handle: number): void {
  if (process.platform !== "win32") return
  const k = getKernel32()
  if (!k) return
  const job = handle as unknown as NonNullable<ReturnType<Kernel32["CreateJobObjectW"]>>
  k.TerminateJobObject(job, 1)
  k.CloseHandle(job)
}

export interface TrackOptions {
  /**
   * Windows: the Job Object kills every process in it when its last handle closes, which
   * happens when this process exits however it exits (a crash, a kill from Task Manager), so
   * nothing in the tree can outlive Amira. Used for background jobs; dispose() then kills too.
   */
  killOnClose?: boolean
}

export function trackProcessTree(proc: Subprocess, opts: TrackOptions = {}): ProcessTree {
  return process.platform === "win32" ? windowsJobTree(proc, opts) : posixGroupTree(proc)
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
    terminate() {
      try {
        process.kill(-proc.pid, "SIGTERM")
      } catch {
        try {
          proc.kill("SIGTERM")
        } catch {}
      }
      return true
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
    SetInformationJobObject: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
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
function windowsJobTree(proc: Subprocess, opts: TrackOptions): ProcessTree {
  const k = getKernel32()
  let job = k?.CreateJobObjectW(null, null) ?? null
  // Kill-on-close is set before the process joins, so there is no moment it could escape it.
  const limited = !opts.killOnClose || !!(k && job && setKillOnClose(k, job))
  const contained = !!(k && job && limited && assignToJob(k, job, proc.pid))
  if (k && job && !contained) {
    k.CloseHandle(job)
    job = null
  }
  return {
    contained,
    ...(job ? { jobHandle: Number(job) } : {}),
    kill() {
      if (k && job) {
        k.TerminateJobObject(job, 1)
        proc.kill()
        return
      }
      // Without a job, taskkill can only find children through a live parent.
      if (proc.exitCode !== null || proc.signalCode !== null) return
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
    terminate: () => false,
    dispose() {
      if (k && job) k.CloseHandle(job)
      job = null
    },
  }
}

/** JobObjectExtendedLimitInformation, and its JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE flag. */
const EXTENDED_LIMIT_INFORMATION = 9
const LIMIT_KILL_ON_JOB_CLOSE = 0x2000
/**
 * JOBOBJECT_EXTENDED_LIMIT_INFORMATION on 64-bit Windows: the basic limits (64 bytes, with
 * LimitFlags at offset 16), IO_COUNTERS (48) and four SIZE_T fields (32).
 */
const EXTENDED_LIMIT_SIZE = 144

function setKillOnClose(k: Kernel32, job: NonNullable<ReturnType<Kernel32["CreateJobObjectW"]>>) {
  const info = new Uint8Array(EXTENDED_LIMIT_SIZE)
  new DataView(info.buffer).setUint32(16, LIMIT_KILL_ON_JOB_CLOSE, true)
  return k.SetInformationJobObject(job, EXTENDED_LIMIT_INFORMATION, ptr(info), EXTENDED_LIMIT_SIZE) !== 0
}
