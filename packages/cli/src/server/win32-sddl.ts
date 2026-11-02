/**
 * Pure Windows security-descriptor policy. Native code only converts descriptors to SDDL text;
 * every trust decision is made here, so it is testable on every OS.
 */

export interface Ace {
  /** "A" allow, "D" deny, "ML" mandatory label, or another SDDL ACE type. */
  type: string
  flags: string[]
  rights: number
  /** Well-known aliases are expanded to their S-1-... form. */
  sid: string
}

export interface SecurityDescriptor {
  owner?: string
  /** Undefined when not requested; null for a NULL DACL (everyone has full access). */
  dacl?: { protected: boolean; aces: Ace[] } | null
  /** Mandatory label ACEs from the SACL part. */
  labels: Ace[]
}

export const SYSTEM = "S-1-5-18"
export const ADMINISTRATORS = "S-1-5-32-544"
const creatorOwner = "S-1-3-0"
const trustedInstaller = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
export const MEDIUM_INTEGRITY = 0x2000
export const HIGH_INTEGRITY = 0x3000

const aliases: Record<string, string> = {
  SY: SYSTEM,
  BA: ADMINISTRATORS,
  BU: "S-1-5-32-545",
  BG: "S-1-5-32-546",
  PU: "S-1-5-32-547",
  CO: creatorOwner,
  CG: "S-1-3-1",
  OW: "S-1-3-4",
  WD: "S-1-1-0",
  AN: "S-1-5-7",
  AU: "S-1-5-11",
  NU: "S-1-5-2",
  IU: "S-1-5-4",
  SU: "S-1-5-6",
  PS: "S-1-5-10",
  RC: "S-1-5-12",
  LS: "S-1-5-19",
  NS: "S-1-5-20",
  AC: "S-1-15-2-1",
  LW: "S-1-16-4096",
  ME: "S-1-16-8192",
  MP: "S-1-16-8448",
  HI: "S-1-16-12288",
  SI: "S-1-16-16384",
}

// Standard and file rights. Generic rights are mapped to their file meaning before any check.
const GENERIC_ALL = 0x10000000
const GENERIC_EXECUTE = 0x20000000
const GENERIC_WRITE = 0x40000000
const GENERIC_READ = 0x80000000
export const FILE_ALL_ACCESS = 0x1f01ff
const FILE_GENERIC_READ = 0x120089
const FILE_GENERIC_WRITE = 0x120116
const FILE_GENERIC_EXECUTE = 0x1200a0
const DELETE = 0x10000
const WRITE_DAC = 0x40000
const WRITE_OWNER = 0x80000
const FILE_ADD_FILE = 0x2
const FILE_ADD_SUBDIRECTORY = 0x4
const FILE_DELETE_CHILD = 0x40
export const LABEL_NO_WRITE_UP = 0x1
export const LABEL_NO_READ_UP = 0x2

const rightCodes: Record<string, number> = {
  GA: GENERIC_ALL,
  GX: GENERIC_EXECUTE,
  GW: GENERIC_WRITE,
  GR: GENERIC_READ,
  FA: FILE_ALL_ACCESS,
  FR: FILE_GENERIC_READ,
  FW: FILE_GENERIC_WRITE,
  FX: FILE_GENERIC_EXECUTE,
  SD: DELETE,
  RC: 0x20000,
  WD: WRITE_DAC,
  WO: WRITE_OWNER,
  CC: 0x1,
  DC: 0x2,
  LC: 0x4,
  SW: 0x8,
  RP: 0x10,
  WP: 0x20,
  DT: 0x40,
  LO: 0x80,
  CR: 0x100,
  KA: 0xf003f,
  KR: 0x20019,
  KW: 0x20006,
  KX: 0x20019,
}
const labelCodes: Record<string, number> = { NW: LABEL_NO_WRITE_UP, NR: LABEL_NO_READ_UP, NX: 0x4 }

function sidOf(value: string): string {
  if (/^S-1-\d+(?:-\d+)*$/.test(value)) return value
  const sid = aliases[value]
  // Domain-relative and unknown aliases never match a trusted SID, so they fail closed.
  return sid ?? `alias:${value}`
}

function parseRights(value: string, label: boolean): number {
  if (/^0x[0-9a-fA-F]+$/.test(value)) return Number.parseInt(value.slice(2), 16) >>> 0
  if (value.length % 2) throw new Error("Invalid SDDL access mask")
  let rights = 0
  const codes = label ? labelCodes : rightCodes
  for (let i = 0; i < value.length; i += 2) {
    const right = codes[value.slice(i, i + 2)]
    if (right === undefined) throw new Error("Invalid SDDL access mask")
    rights = (rights | right) >>> 0
  }
  return rights
}

function parseAces(text: string): Ace[] {
  const aces: Ace[] = []
  let rest = text
  while (rest.length) {
    if (rest[0] !== "(") throw new Error("Invalid SDDL ACE list")
    const end = rest.indexOf(")")
    if (end < 0) throw new Error("Invalid SDDL ACE list")
    const fields = rest.slice(1, end).split(";")
    if (fields.length < 6) throw new Error("Invalid SDDL ACE")
    const [type, flags, rights, , , sid] = fields as [string, string, string, string, string, string]
    const flagList = flags.match(/.{2}/g) ?? []
    if (flagList.join("") !== flags) throw new Error("Invalid SDDL ACE flags")
    aces.push({ type, flags: flagList, rights: parseRights(rights, type === "ML"), sid: sidOf(sid) })
    rest = rest.slice(end + 1)
  }
  return aces
}

/** Parses the owner, DACL and label parts that ConvertSecurityDescriptorToStringSecurityDescriptorW emits. */
export function parseSddl(text: string): SecurityDescriptor {
  const parts = new Map<string, string>()
  const pattern = /([OGDS]):/g
  const starts: { tag: string; at: number }[] = []
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    // A tag only starts at the beginning or right after a SID or an ACE list.
    if (match.index === 0 || /[)\dA-Z]/.test(text[match.index - 1]!))
      starts.push({ tag: match[1]!, at: match.index })
  }
  for (const [index, start] of starts.entries()) {
    if (parts.has(start.tag)) throw new Error("Invalid SDDL")
    parts.set(start.tag, text.slice(start.at + 2, starts[index + 1]?.at ?? text.length))
  }
  if (!starts.length || starts[0]!.at !== 0) throw new Error("Invalid SDDL")
  const descriptor: SecurityDescriptor = { labels: [] }
  const owner = parts.get("O")
  if (owner !== undefined) descriptor.owner = sidOf(owner)
  const dacl = parts.get("D")
  if (dacl !== undefined) {
    const open = dacl.indexOf("(")
    const flags = open < 0 ? dacl : dacl.slice(0, open)
    if (flags.includes("NO_ACCESS_CONTROL")) descriptor.dacl = null
    else {
      if (!/^(?:P|AI|AR)*$/.test(flags)) throw new Error("Invalid SDDL DACL flags")
      descriptor.dacl = { protected: flags.includes("P"), aces: open < 0 ? [] : parseAces(dacl.slice(open)) }
    }
  }
  const sacl = parts.get("S")
  if (sacl !== undefined) {
    const open = sacl.indexOf("(")
    descriptor.labels = open < 0 ? [] : parseAces(sacl.slice(open)).filter((ace) => ace.type === "ML")
  }
  return descriptor
}

/** Maps generic rights to the file rights they grant. */
function fileRights(rights: number): number {
  let mapped = rights & 0x0fffffff
  if (rights & GENERIC_ALL) mapped |= FILE_ALL_ACCESS
  if (rights & GENERIC_READ) mapped |= FILE_GENERIC_READ
  if (rights & GENERIC_WRITE) mapped |= FILE_GENERIC_WRITE
  if (rights & GENERIC_EXECUTE) mapped |= FILE_GENERIC_EXECUTE
  return mapped >>> 0
}

const inheritOnly = (ace: Ace) => ace.flags.includes("IO")
const integrityRid = (sid: string) => {
  const match = /^S-1-16-(\d+)$/.exec(sid)
  return match ? Number(match[1]) : undefined
}

/**
 * A private discovery directory or file: owned by the principal, a real DACL whose allow ACEs
 * (inherited ones included) name only the principal and SYSTEM, and no label below Medium
 * no-read-up. Deny ACEs only narrow access and are fine.
 */
export function privateDescriptorProblem(
  descriptor: SecurityDescriptor,
  principal: { user: string; owners: readonly string[] },
): string | undefined {
  if (!descriptor.owner || !principal.owners.includes(descriptor.owner)) return "foreign owner"
  if (!descriptor.dacl) return "missing DACL"
  for (const ace of descriptor.dacl.aces) {
    if (ace.type === "D") continue
    if (ace.type !== "A") return "unexpected ACE"
    if (ace.sid !== principal.user && ace.sid !== SYSTEM) return "foreign access"
  }
  for (const label of descriptor.labels) {
    const rid = integrityRid(label.sid)
    if (
      rid === undefined ||
      rid < MEDIUM_INTEGRITY ||
      (label.rights & (LABEL_NO_READ_UP | LABEL_NO_WRITE_UP)) !== (LABEL_NO_READ_UP | LABEL_NO_WRITE_UP)
    )
      return "weak integrity label"
  }
  return undefined
}

const trustedSids = (user: string) => new Set([user, SYSTEM, ADMINISTRATORS, trustedInstaller, creatorOwner])

/**
 * Whether anyone but the principal, SYSTEM, administrators or TrustedInstaller can replace the
 * directory `child` (listed under `parent`): change its security, own it, or delete or rename it
 * while able to create a substitute next to it. Reading and adding unrelated entries is fine:
 * every private directory below is owner-, DACL- and reparse-checked on each use.
 * Group membership is not resolved, so any other SID counts as untrusted.
 */
export function ancestorProblem(
  child: SecurityDescriptor,
  parent: SecurityDescriptor | undefined,
  user: string,
): string | undefined {
  const trusted = trustedSids(user)
  if (!child.owner || !trusted.has(child.owner)) return "foreign owner"
  if (!child.dacl) return "missing DACL"
  const grants = (descriptor: SecurityDescriptor | undefined) => {
    const result = new Map<string, number>()
    if (!descriptor) return result
    if (descriptor.dacl === null) return new Map([["*", FILE_ALL_ACCESS]])
    for (const ace of descriptor.dacl?.aces ?? []) {
      if (ace.type !== "A" || inheritOnly(ace) || trusted.has(ace.sid)) continue
      result.set(ace.sid, (result.get(ace.sid) ?? 0) | fileRights(ace.rights))
    }
    return result
  }
  const parentGrants = grants(parent)
  const parentAll = parentGrants.get("*") ?? 0
  for (const [sid, rights] of grants(child)) {
    if (rights & (WRITE_DAC | WRITE_OWNER | FILE_DELETE_CHILD)) return "foreign control"
    const parentRights = (parentGrants.get(sid) ?? 0) | parentAll
    if (rights & DELETE && parentRights & (FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY)) return "foreign rename"
  }
  for (const [sid, rights] of parentGrants) {
    if (sid === "*") continue
    if (rights & FILE_DELETE_CHILD && rights & (FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY))
      return "foreign rename"
  }
  if (parentAll & FILE_DELETE_CHILD) return "foreign rename"
  return undefined
}

/** The exact state lockdown must leave on a daemon pipe: owner, protected user-only DACL, Medium label. */
export function lockedPipeProblem(descriptor: SecurityDescriptor, user: string): string | undefined {
  const [ace, ...extra] = descriptor.dacl?.aces ?? []
  const [label, ...extraLabels] = descriptor.labels
  if (descriptor.owner !== user) return "foreign owner"
  if (!descriptor.dacl?.protected || !ace || extra.length) return "unexpected DACL"
  if (ace.type !== "A" || ace.flags.length || ace.sid !== user || fileRights(ace.rights) !== FILE_ALL_ACCESS)
    return "unexpected DACL"
  if (
    !label ||
    extraLabels.length ||
    integrityRid(label.sid) !== MEDIUM_INTEGRITY ||
    label.flags.length ||
    label.rights !== (LABEL_NO_READ_UP | LABEL_NO_WRITE_UP)
  )
    return "unexpected label"
  return undefined
}

/** SDDL lockdown writes on a fresh daemon pipe. */
export const lockedPipeSddl = (user: string) => `O:${user}D:P(A;;GA;;;${user})S:(ML;;NWNR;;;ME)`
/** SDDL for a private discovery directory; children inherit both ACEs and the label. */
export const privateDirectorySddl = (user: string) =>
  `O:${user}D:P(A;OICI;FA;;;${user})(A;OICI;FA;;;SY)S:(ML;OICI;NRNW;;;ME)`

/**
 * Only Medium integrity runs or attaches to a daemon, or High/System when UAC is off (no Medium
 * half of this user exists then). An elevated session with UAC on would let the same user's
 * Medium processes drive an elevated agent, so it stays in-process; below Medium is refused too.
 */
export function integrityProblem(rid: number, enableLua: number | undefined): string | undefined {
  if (rid < MEDIUM_INTEGRITY) return "low integrity"
  if (rid < HIGH_INTEGRITY) return undefined
  return enableLua === 0 ? undefined : "elevated with UAC on"
}
