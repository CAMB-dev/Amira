import { dlopen, type Pointer, ptr, toArrayBuffer } from "bun:ffi"

/**
 * Windows x64 bindings for daemon security and identity. Only conversions and OS facts live
 * here; trust decisions are in win32-sddl.ts. Libraries are opened once, on first use.
 * HANDLE and pointer results are u64 (compared against INVALID_HANDLE_VALUE), BOOL is i32.
 */

const INVALID_HANDLE = 0xffffffffffffffffn
const ERROR_ALREADY_EXISTS = 183
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004 | 0
const HKLM = 0xffffffff80000002n
const RRF_RT_REG_SZ = 0x2
const RRF_RT_REG_DWORD = 0x10
const RRF_SUBKEY_WOW6464KEY = 0x10000
const STILL_ACTIVE = 259
const SE_FILE_OBJECT = 1
const SE_KERNEL_OBJECT = 6
const OWNER_SECURITY_INFORMATION = 0x1
const DACL_SECURITY_INFORMATION = 0x4
const LABEL_SECURITY_INFORMATION = 0x10
const PROTECTED_DACL_SECURITY_INFORMATION = 0x80000000
const SECURITY_INFO = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION

function load() {
  const kernel32 = dlopen("kernel32.dll", {
    GetLastError: { args: [], returns: "u32" },
    GetCurrentProcess: { args: [], returns: "u64" },
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetProcessTimes: { args: ["u64", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    GetExitCodeProcess: { args: ["u64", "ptr"], returns: "i32" },
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    CreateDirectoryW: { args: ["ptr", "ptr"], returns: "i32" },
    GetFileAttributesW: { args: ["ptr"], returns: "u32" },
    SetFileAttributesW: { args: ["ptr", "u32"], returns: "i32" },
    GetDriveTypeW: { args: ["ptr"], returns: "u32" },
    IsProcessInJob: { args: ["u64", "u64", "ptr"], returns: "i32" },
    QueryInformationJobObject: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
    LocalFree: { args: ["u64"], returns: "u64" },
    lstrlenW: { args: ["u64"], returns: "i32" },
  }).symbols
  const advapi32 = dlopen("advapi32.dll", {
    OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "i32" },
    GetTokenInformation: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
    ConvertSidToStringSidW: { args: ["u64", "ptr"], returns: "i32" },
    RegGetValueW: { args: ["u64", "ptr", "ptr", "u32", "ptr", "ptr", "ptr"], returns: "i32" },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: {
      args: ["ptr", "u32", "ptr", "ptr"],
      returns: "i32",
    },
    ConvertSecurityDescriptorToStringSecurityDescriptorW: {
      args: ["u64", "u32", "u32", "ptr", "ptr"],
      returns: "i32",
    },
    GetSecurityDescriptorOwner: { args: ["u64", "ptr", "ptr"], returns: "i32" },
    GetSecurityDescriptorDacl: { args: ["u64", "ptr", "ptr", "ptr"], returns: "i32" },
    GetSecurityDescriptorSacl: { args: ["u64", "ptr", "ptr", "ptr"], returns: "i32" },
    GetSecurityInfo: { args: ["u64", "u32", "u32", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
    SetSecurityInfo: { args: ["u64", "u32", "u32", "u64", "u64", "u64", "u64"], returns: "u32" },
    GetNamedSecurityInfoW: { args: ["ptr", "u32", "u32", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
  }).symbols
  const ntdll = dlopen("ntdll.dll", {
    NtQuerySystemInformation: { args: ["u32", "ptr", "u32", "ptr"], returns: "i32" },
  }).symbols
  const shell32 = dlopen("shell32.dll", {
    SHGetKnownFolderPath: { args: ["ptr", "u32", "u64", "ptr"], returns: "i32" },
  }).symbols
  const ole32 = dlopen("ole32.dll", { CoTaskMemFree: { args: ["u64"], returns: "void" } }).symbols
  return { kernel32, advapi32, ntdll, shell32, ole32 }
}

let libraries: ReturnType<typeof load> | undefined
const native = () => {
  if (process.platform !== "win32") throw new Error("Windows daemon bindings require Windows")
  libraries ??= load()
  return libraries
}

/** A Win32 failure; `code` follows Node for the cases discovery treats specially. */
export class Win32Error extends Error {
  readonly code?: string
  constructor(
    readonly operation: string,
    readonly win32: number,
  ) {
    super(`${operation} failed (${win32})`)
    this.name = "Win32Error"
    if (win32 === 2 || win32 === 3) this.code = "ENOENT"
  }
}

// Passed as the argument itself, never through ptr(), so the call keeps the buffer alive.
const wide = (value: string) => Buffer.from(`${value}\0`, "utf16le")
const out = () => new BigUint64Array(1)
const lastError = () => native().kernel32.GetLastError()

function readWide(address: bigint): string {
  const { kernel32 } = native()
  const length = kernel32.lstrlenW(address)
  return Buffer.from(toArrayBuffer(Number(address) as Pointer, 0, length * 2)).toString("utf16le")
}

function localString(address: bigint): string {
  try {
    return readWide(address)
  } finally {
    native().kernel32.LocalFree(address)
  }
}

function sidString(sid: bigint): string {
  const text = out()
  if (!native().advapi32.ConvertSidToStringSidW(sid, ptr(text)))
    throw new Win32Error("ConvertSidToStringSid", lastError())
  return localString(text[0]!)
}

// TOKEN_QUERY; the shell also needs TOKEN_IMPERSONATE | TOKEN_DUPLICATE.
function withProcessToken<T>(read: (token: bigint) => T, access = 0x8): T {
  const { kernel32, advapi32 } = native()
  const token = out()
  if (!advapi32.OpenProcessToken(kernel32.GetCurrentProcess(), access, ptr(token)))
    throw new Win32Error("OpenProcessToken", lastError())
  try {
    return read(token[0]!)
  } finally {
    kernel32.CloseHandle(token[0]!)
  }
}

function tokenInformation(token: bigint, kind: number): Uint8Array {
  const buffer = new Uint8Array(512)
  const length = new Uint32Array(1)
  if (!native().advapi32.GetTokenInformation(token, kind, ptr(buffer), buffer.byteLength, ptr(length)))
    throw new Win32Error("GetTokenInformation", lastError())
  return buffer
}

const firstPointer = (buffer: Uint8Array) => new BigUint64Array(buffer.buffer, 0, 1)[0]!

/** The process token's user SID, its default owner SID, and its integrity RID. */
export function tokenFacts(): { user: string; owner: string; integrity: number } {
  return withProcessToken((token) => {
    // TokenUser = 1, TokenOwner = 4, TokenIntegrityLevel = 25: each starts with a SID pointer.
    const user = sidString(firstPointer(tokenInformation(token, 1)))
    const owner = sidString(firstPointer(tokenInformation(token, 4)))
    const integrity = sidString(firstPointer(tokenInformation(token, 25)))
    const rid = /^S-1-16-(\d+)$/.exec(integrity)
    if (!rid) throw new Error("Unexpected token integrity level")
    return { user, owner, integrity: Number(rid[1]) }
  })
}

function registryValue(key: string, name: string, type: "string" | "dword"): string | number | undefined {
  const data = new Uint8Array(512)
  const size = new Uint32Array([data.byteLength])
  const flags = (type === "string" ? RRF_RT_REG_SZ : RRF_RT_REG_DWORD) | RRF_SUBKEY_WOW6464KEY
  const status = native().advapi32.RegGetValueW(
    HKLM,
    wide(key),
    wide(name),
    flags,
    null,
    ptr(data),
    ptr(size),
  )
  if (status !== 0) return undefined
  if (type === "dword") return new DataView(data.buffer).getUint32(0, true)
  return Buffer.from(data.buffer, 0, Math.max(0, size[0]! - 2)).toString("utf16le")
}

/** UAC's EnableLUA policy, undefined when the value is absent. */
export function enableLua(): number | undefined {
  const value = registryValue(
    "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System",
    "EnableLUA",
    "dword",
  )
  return typeof value === "number" ? value : undefined
}

/** The installation's MachineGuid, a stable machine-local identity readable without elevation. */
export function machineGuid(): string | undefined {
  const value = registryValue("SOFTWARE\\Microsoft\\Cryptography", "MachineGuid", "string")
  return typeof value === "string" && /^[0-9a-fA-F-]{36}$/.test(value) ? value.toLowerCase() : undefined
}

/** UniqueProcessId -> CreateTime for every process, without opening any of them. */
export function processCreationTimes(): Map<number, bigint> {
  const { ntdll } = native()
  let size = 1 << 21
  for (let attempt = 0; attempt < 8; attempt++) {
    const buffer = new Uint8Array(size)
    const needed = new Uint32Array(1)
    // SystemProcessInformation = 5
    const status = ntdll.NtQuerySystemInformation(5, ptr(buffer), size, ptr(needed))
    if (status === STATUS_INFO_LENGTH_MISMATCH) {
      size = Math.max(size * 2, needed[0]! + 65536)
      continue
    }
    if (status !== 0) throw new Win32Error("NtQuerySystemInformation", status >>> 0)
    const view = new DataView(buffer.buffer)
    const times = new Map<number, bigint>()
    // SYSTEM_PROCESS_INFORMATION (x64): NextEntryOffset at 0, CreateTime at 0x20, UniqueProcessId at 0x50.
    for (let offset = 0; ; ) {
      times.set(Number(view.getBigUint64(offset + 0x50, true)), view.getBigUint64(offset + 0x20, true))
      const next = view.getUint32(offset, true)
      if (!next) break
      offset += next
    }
    return times
  }
  throw new Error("The process list kept growing")
}

/**
 * Creation time (100 ns since 1601) of a running process, or undefined when it has exited or
 * never existed. Creation time is not adjusted by clock changes, so (pid, time) is a process.
 */
export function processCreationTime(pid: number): bigint | undefined {
  const { kernel32 } = native()
  // PROCESS_QUERY_LIMITED_INFORMATION
  const handle = kernel32.OpenProcess(0x1000, 0, pid)
  if (!handle) {
    const error = lastError()
    // 87 means no such process, 5 another user's, a service's or a protected one. The system list
    // needs no handle and confirms both: the error code is read in a separate call, so trusting a
    // stray 87 could declare a live lease owner dead. An exited process is no longer listed even
    // while someone still holds a handle to it.
    if (error === 87 || error === 5) return processCreationTimes().get(pid)
    throw new Win32Error("OpenProcess", error)
  }
  try {
    const code = new Uint32Array(1)
    if (!kernel32.GetExitCodeProcess(handle, ptr(code)))
      throw new Win32Error("GetExitCodeProcess", lastError())
    if (code[0] !== STILL_ACTIVE) return undefined
    const times = new BigUint64Array(4)
    if (!kernel32.GetProcessTimes(handle, ptr(times, 0), ptr(times, 8), ptr(times, 16), ptr(times, 24)))
      throw new Win32Error("GetProcessTimes", lastError())
    return times[0]!
  } finally {
    kernel32.CloseHandle(handle)
  }
}

/**
 * FOLDERID_LocalAppData for this token, never from %LOCALAPPDATA%. Without a token the shell
 * expands the folder with this process's %USERPROFILE%; with one it uses the account's own
 * environment. The shell caches the first answer per process, so nothing here asks without one.
 */
export function localAppData(): string {
  const { shell32, ole32 } = native()
  const guid = Buffer.alloc(16)
  guid.writeUInt32LE(0xf1b32785, 0)
  guid.writeUInt16LE(0x6fba, 4)
  guid.writeUInt16LE(0x4fcf, 6)
  Buffer.from([0x9d, 0x55, 0x7b, 0x8e, 0x7f, 0x15, 0x70, 0x91]).copy(guid, 8)
  const result = out()
  const status = withProcessToken(
    (token) => shell32.SHGetKnownFolderPath(ptr(guid), 0, token, ptr(result)),
    0xe,
  )
  try {
    if (status !== 0) throw new Win32Error("SHGetKnownFolderPath", status >>> 0)
    return readWide(result[0]!)
  } finally {
    ole32.CoTaskMemFree(result[0]!)
  }
}

export const DRIVE_FIXED = 3
export const DRIVE_REMOTE = 4
export function driveType(root: string): number {
  return native().kernel32.GetDriveTypeW(wide(root))
}

export const FILE_ATTRIBUTE_REPARSE_POINT = 0x400
export const FILE_ATTRIBUTE_NOT_CONTENT_INDEXED = 0x2000
export function fileAttributes(file: string): number {
  const attributes = native().kernel32.GetFileAttributesW(wide(file))
  if (attributes === 0xffffffff) throw new Win32Error("GetFileAttributes", lastError())
  return attributes
}
export function setFileAttributes(file: string, attributes: number): void {
  if (!native().kernel32.SetFileAttributesW(wide(file), attributes))
    throw new Win32Error("SetFileAttributes", lastError())
}

function toSddl(descriptor: bigint): string {
  const text = out()
  if (
    !native().advapi32.ConvertSecurityDescriptorToStringSecurityDescriptorW(
      descriptor,
      1,
      SECURITY_INFO,
      ptr(text),
      null,
    )
  )
    throw new Win32Error("ConvertSecurityDescriptorToStringSecurityDescriptor", lastError())
  return localString(text[0]!)
}

function withDescriptor<T>(sddl: string, use: (descriptor: bigint) => T): T {
  const { advapi32, kernel32 } = native()
  const descriptor = out()
  if (!advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(wide(sddl), 1, ptr(descriptor), null))
    throw new Win32Error("ConvertStringSecurityDescriptorToSecurityDescriptor", lastError())
  try {
    return use(descriptor[0]!)
  } finally {
    kernel32.LocalFree(descriptor[0]!)
  }
}

/** Owner, DACL and label of a file or directory as SDDL. */
export function fileSddl(file: string): string {
  const descriptor = out()
  const status = native().advapi32.GetNamedSecurityInfoW(
    wide(file),
    SE_FILE_OBJECT,
    SECURITY_INFO,
    null,
    null,
    null,
    null,
    ptr(descriptor),
  )
  if (status !== 0) throw new Win32Error("GetNamedSecurityInfo", status)
  try {
    return toSddl(descriptor[0]!)
  } finally {
    native().kernel32.LocalFree(descriptor[0]!)
  }
}

/** Creates a directory with an explicit descriptor; false when it already existed (left untouched). */
export function createDirectory(file: string, sddl: string): boolean {
  return withDescriptor(sddl, (descriptor) => {
    // SECURITY_ATTRIBUTES: nLength, padding, lpSecurityDescriptor, bInheritHandle.
    const attributes = new BigUint64Array(3)
    new Uint32Array(attributes.buffer)[0] = 24
    attributes[1] = descriptor
    if (native().kernel32.CreateDirectoryW(wide(file), ptr(attributes))) return true
    const error = lastError()
    if (error === ERROR_ALREADY_EXISTS) return false
    throw new Win32Error("CreateDirectory", error)
  })
}

/** Opens an existing file or pipe; the error code is returned, not thrown, for retry decisions. */
export function openHandle(
  file: string,
  access: number,
  share = 0,
): { handle: bigint; error?: undefined } | { handle?: undefined; error: number } {
  // OPEN_EXISTING = 3
  const handle = native().kernel32.CreateFileW(wide(file), access, share, null, 3, 0, 0n)
  return handle === INVALID_HANDLE ? { error: lastError() } : { handle }
}

export function closeHandle(handle: bigint): void {
  native().kernel32.CloseHandle(handle)
}

/** Owner, DACL and label of a kernel object (a pipe) through an open handle. */
export function handleSddl(handle: bigint): string {
  const descriptor = out()
  const status = native().advapi32.GetSecurityInfo(
    handle,
    SE_KERNEL_OBJECT,
    SECURITY_INFO,
    null,
    null,
    null,
    null,
    ptr(descriptor),
  )
  if (status !== 0) throw new Win32Error("GetSecurityInfo", status)
  try {
    return toSddl(descriptor[0]!)
  } finally {
    native().kernel32.LocalFree(descriptor[0]!)
  }
}

/** Replaces owner, a protected DACL and the label of a kernel object in one call. */
export function setHandleSddl(handle: bigint, sddl: string): void {
  const { advapi32 } = native()
  withDescriptor(sddl, (descriptor) => {
    const owner = out()
    const dacl = out()
    const sacl = out()
    const present = new Int32Array(1)
    const defaulted = new Int32Array(1)
    if (
      !advapi32.GetSecurityDescriptorOwner(descriptor, ptr(owner), ptr(defaulted)) ||
      !advapi32.GetSecurityDescriptorDacl(descriptor, ptr(present), ptr(dacl), ptr(defaulted)) ||
      !advapi32.GetSecurityDescriptorSacl(descriptor, ptr(present), ptr(sacl), ptr(defaulted))
    )
      throw new Win32Error("GetSecurityDescriptor", lastError())
    const status = advapi32.SetSecurityInfo(
      handle,
      SE_KERNEL_OBJECT,
      SECURITY_INFO | PROTECTED_DACL_SECURITY_INFORMATION,
      owner[0]!,
      0n,
      dacl[0]!,
      sacl[0]!,
    )
    if (status !== 0) throw new Win32Error("SetSecurityInfo", status)
  })
}

export const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x800
export const JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x1000
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
/** Limit flags of the job this process is in (the innermost one), or undefined outside a job. */
export function jobLimitFlags(): number | undefined {
  const { kernel32 } = native()
  const inJob = new Int32Array(1)
  if (!kernel32.IsProcessInJob(kernel32.GetCurrentProcess(), 0n, ptr(inJob)))
    throw new Win32Error("IsProcessInJob", lastError())
  if (!inJob[0]) return undefined
  // JobObjectExtendedLimitInformation = 9; LimitFlags is at offset 16 of the 144-byte struct.
  const info = new Uint8Array(144)
  if (!kernel32.QueryInformationJobObject(0n, 9, ptr(info), info.byteLength, null))
    throw new Win32Error("QueryInformationJobObject", lastError())
  return new DataView(info.buffer).getUint32(16, true)
}
