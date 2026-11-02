import { dlopen, ptr } from "bun:ffi"

/**
 * Opens a locked daemon pipe for read and write while impersonating three variants of this
 * process's own token, then reverts. A subprocess, so a failed revert cannot leak into tests.
 * Prints `{ low, restricted, normal }`: 0 for an opened pipe, otherwise the Win32 error.
 */
const kernel32 = dlopen("kernel32.dll", {
  GetCurrentProcess: { args: [], returns: "u64" },
  GetLastError: { args: [], returns: "u32" },
  CloseHandle: { args: ["u64"], returns: "i32" },
  CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
}).symbols
const advapi32 = dlopen("advapi32.dll", {
  OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "i32" },
  GetTokenInformation: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
  DuplicateTokenEx: { args: ["u64", "u32", "ptr", "u32", "u32", "ptr"], returns: "i32" },
  SetTokenInformation: { args: ["u64", "u32", "ptr", "u32"], returns: "i32" },
  ConvertStringSidToSidW: { args: ["ptr", "ptr"], returns: "i32" },
  CreateRestrictedToken: {
    args: ["u64", "u32", "u32", "ptr", "u32", "ptr", "u32", "ptr", "ptr"],
    returns: "i32",
  },
  ImpersonateLoggedOnUser: { args: ["u64"], returns: "i32" },
  RevertToSelf: { args: [], returns: "i32" },
}).symbols

const pipe = process.argv[2]!
const wide = (value: string) => Buffer.from(`${value}\0`, "utf16le")
const must = (ok: number, what: string) => {
  if (!ok) throw new Error(`${what} failed (${kernel32.GetLastError()})`)
}

const own = new BigUint64Array(1)
// TOKEN_ALL_ACCESS on this process's own token.
must(advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), 0xf01ff, ptr(own)), "OpenProcessToken")
const token = own[0]!

function duplicate(): bigint {
  const out = new BigUint64Array(1)
  // MAXIMUM_ALLOWED, SecurityImpersonation, TokenImpersonation
  must(advapi32.DuplicateTokenEx(token, 0x02000000, null, 2, 2, ptr(out)), "DuplicateTokenEx")
  return out[0]!
}

function openAs(impersonation: bigint): number {
  must(advapi32.ImpersonateLoggedOnUser(impersonation), "ImpersonateLoggedOnUser")
  try {
    // GENERIC_READ | GENERIC_WRITE, OPEN_EXISTING
    const handle = kernel32.CreateFileW(ptr(wide(pipe)), 0xc0000000, 0, null, 3, 0, 0n)
    if (handle === 0xffffffffffffffffn) return kernel32.GetLastError()
    kernel32.CloseHandle(handle)
    return 0
  } finally {
    must(advapi32.RevertToSelf(), "RevertToSelf")
    kernel32.CloseHandle(impersonation)
  }
}

const low = duplicate()
const lowSid = new BigUint64Array(1)
must(advapi32.ConvertStringSidToSidW(ptr(wide("S-1-16-4096")), ptr(lowSid)), "ConvertStringSidToSid")
// TOKEN_MANDATORY_LABEL { SID_AND_ATTRIBUTES { Sid, Attributes = SE_GROUP_INTEGRITY } }
const label = new BigUint64Array([lowSid[0]!, 0x20n])
must(advapi32.SetTokenInformation(low, 25, ptr(label), 16 + 12), "SetTokenInformation")

const user = new Uint8Array(256)
const length = new Uint32Array(1)
must(advapi32.GetTokenInformation(token, 1, ptr(user), user.byteLength, ptr(length)), "GetTokenInformation")
// Disable the user SID: it becomes deny-only, as for a sandboxed or restricted caller.
const disable = new BigUint64Array([new BigUint64Array(user.buffer, 0, 1)[0]!, 0n])
const restrictedOut = new BigUint64Array(1)
must(
  advapi32.CreateRestrictedToken(token, 0, 1, ptr(disable), 0, null, 0, null, ptr(restrictedOut)),
  "CreateRestrictedToken",
)

process.stdout.write(
  JSON.stringify({ low: openAs(low), restricted: openAs(restrictedOut[0]!), normal: openAs(duplicate()) }),
)
