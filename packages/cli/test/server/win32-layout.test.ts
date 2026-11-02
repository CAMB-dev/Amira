import "./offline.ts"
import { expect, test } from "bun:test"
import { daemonAttachFault } from "../../src/server/errors.ts"
import { DaemonUnavailableError, daemonFallback } from "../../src/server/fallback.ts"
import { DRIVE_FIXED, DRIVE_REMOTE } from "../../src/server/win32-ffi.ts"
import {
  assertDaemonIntegrity,
  randomPipeName,
  retrySharingViolations,
  validPipeName,
  windowsWorkspace,
} from "../../src/server/win32-layout.ts"
import { jobProblem } from "../../src/server/win32-platform.ts"
import { HIGH_INTEGRITY, MEDIUM_INTEGRITY } from "../../src/server/win32-sddl.ts"

const reason = (run: () => unknown) => {
  try {
    run()
  } catch (error) {
    return daemonFallback(error)?.reason ?? (error as Error).message
  }
  return undefined
}

test("pipe names are fresh, unprefixed 128-bit names and nothing else validates", () => {
  const names = new Set(Array.from({ length: 32 }, randomPipeName))
  expect(names.size).toBe(32)
  for (const name of names) expect(validPipeName(name)).toBe(true)
  for (const bad of [
    "\\\\.\\pipe\\amira-0123456789abcdef0123456789abcde",
    "\\\\.\\pipe\\amira-0123456789abcdef0123456789abcdef0",
    "\\\\.\\pipe\\amira-0123456789ABCDEF0123456789ABCDEF",
    "\\\\host\\pipe\\amira-0123456789abcdef0123456789abcdef",
    "\\\\.\\pipe\\amira-S-1-5-21-0123456789abcdef0123456789abcdef",
    "/tmp/amira-1-workspaces/0123456789abcdef01234567/daemon.sock",
  ])
    expect(validPipeName(bad)).toBe(false)
})

test("workspaces on UNC paths and network drives stay in-process; local drive letters are upper-cased", () => {
  const types: string[] = []
  const local = (root: string) => {
    types.push(root)
    return DRIVE_FIXED
  }
  expect(windowsWorkspace("d:\\dev\\Amira", local)).toBe("D:\\dev\\Amira")
  expect(types).toEqual(["D:\\"])
  expect(reason(() => windowsWorkspace("\\\\server\\share\\repo", local))).toBe("network")
  expect(reason(() => windowsWorkspace("\\\\?\\UNC\\server\\share", local))).toBe("network")
  expect(reason(() => windowsWorkspace("Z:\\repo", () => DRIVE_REMOTE))).toBe("network")
  // DRIVE_UNKNOWN and DRIVE_NO_ROOT_DIR are not local volumes either.
  expect(reason(() => windowsWorkspace("Q:\\repo", () => 0))).toBe("network")
  expect(reason(() => windowsWorkspace("Q:\\repo", () => 1))).toBe("network")
  // Removable and RAM disks are local to this machine.
  expect(windowsWorkspace("e:\\repo", () => 2)).toBe("E:\\repo")
})

test("sharing violations are retried a bounded number of times; other errors are not", () => {
  const busy = (code: string) => Object.assign(new Error(code), { code })
  let calls = 0
  let pauses = 0
  expect(
    retrySharingViolations(
      () => {
        if (++calls < 4) throw busy(["EPERM", "EBUSY", "EACCES"][calls - 1]!)
        return "done"
      },
      () => pauses++,
    ),
  ).toBe("done")
  expect([calls, pauses]).toEqual([4, 3])
  calls = 0
  expect(() =>
    retrySharingViolations(
      () => {
        calls++
        throw busy("EBUSY")
      },
      () => {},
    ),
  ).toThrow("EBUSY")
  expect(calls).toBe(10)
  calls = 0
  expect(() =>
    retrySharingViolations(
      () => {
        calls++
        throw busy("ENOENT")
      },
      () => {},
    ),
  ).toThrow("ENOENT")
  expect(calls).toBe(1)
})

test("the integrity rule maps refusals to the in-process fallback and reads UAC only above Medium", () => {
  let reads = 0
  const lua = (value: number | undefined) => () => {
    reads++
    return value
  }
  expect(reason(() => assertDaemonIntegrity(MEDIUM_INTEGRITY, lua(1)))).toBeUndefined()
  expect(reads).toBe(0)
  expect(reason(() => assertDaemonIntegrity(HIGH_INTEGRITY, lua(0)))).toBeUndefined()
  expect(reason(() => assertDaemonIntegrity(HIGH_INTEGRITY, lua(1)))).toBe("integrity")
  expect(reason(() => assertDaemonIntegrity(HIGH_INTEGRITY, lua(undefined)))).toBe("integrity")
  expect(reason(() => assertDaemonIntegrity(0x1000, lua(0)))).toBe("integrity")
  expect(reads).toBe(3)
})

test("a job that ends its processes on close refuses the daemon unless children leave it silently", () => {
  expect(jobProblem(undefined)).toBeUndefined()
  expect(jobProblem(0)).toBeUndefined()
  // Breakaway allowed but not silent: Bun's detached spawn does not ask, so the child stays inside.
  expect(jobProblem(0x2000 | 0x800)).toBe("kill on job close")
  expect(jobProblem(0x2000)).toBe("kill on job close")
  expect(jobProblem(0x2000 | 0x1000)).toBeUndefined()
  expect(jobProblem(0x1800)).toBeUndefined()
})

test("refusals become a sanitized startup fault for relays and a fallback reason for frontends", () => {
  for (const reasonName of ["integrity", "job", "network", "ancestor", "start"] as const) {
    const error = new DaemonUnavailableError(reasonName)
    expect(daemonFallback(error)).toEqual({ reason: reasonName, message: error.message })
    expect(daemonAttachFault(error)).toEqual({ code: "startup_failed", message: error.message })
    expect(error.message).not.toMatch(/[\\/]|S-1-/)
  }
  expect(daemonFallback(new Error("Daemon path is not private (foreign access)"))).toBeUndefined()
  expect(daemonAttachFault(new Error("C:\\secret"))).toEqual({
    code: "startup_failed",
    message: "The remote workspace could not attach",
  })
})
