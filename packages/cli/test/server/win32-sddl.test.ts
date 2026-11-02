import { expect, test } from "bun:test"
import {
  ADMINISTRATORS,
  ancestorProblem,
  HIGH_INTEGRITY,
  integrityProblem,
  lockedPipeProblem,
  lockedPipeSddl,
  MEDIUM_INTEGRITY,
  parseSddl,
  privateDescriptorProblem,
  privateDirectorySddl,
  SYSTEM,
} from "../../src/server/win32-sddl.ts"

// Shapes recorded on a Windows 11 machine (account SIDs replaced). The second account is a local
// sandbox group that a coding tool granted modify on the profile's AppData folders.
const USER = "S-1-5-21-1000-2000-3000-1001"
const OTHER = "S-1-5-21-1000-2000-3000-1002"
const principal = { user: USER, owners: [USER] }
const realLocalAppData = `O:${USER}D:AI(A;OICI;0x1301bf;;;${OTHER})(A;OICIID;0x1200a9;;;${OTHER})(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})`
const realAppData = `O:${USER}D:AI(A;OICI;0x1301bf;;;${OTHER})(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})`
const realProfile = `O:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${USER})(A;;0x100020;;;S-1-15-3-65536-1-2-3-4-5-6-7-8)`
const realUsers =
  "O:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x1200a9;;;BU)(A;OICIIO;GXGR;;;BU)(A;;0x1200a9;;;WD)(A;OICIIO;GXGR;;;WD)"
const realDrive =
  "O:S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464D:PAI(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;BU)(A;OICIIO;SDGXGWGR;;;AU)(A;;LC;;;AU)S:P(ML;OINPIO;NW;;;HI)"
const plainLocalAppData = `O:${USER}D:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})`
const defaultPipe = `O:${USER}D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${USER})(A;;FR;;;WD)(A;;FR;;;AN)`
const lockedPipe = `O:${USER}D:P(A;;FA;;;${USER})S:(ML;;NWNR;;;ME)`

test("the parser expands aliases, hex masks, flags, protection, NULL DACLs and labels", () => {
  const parsed = parseSddl(realLocalAppData)
  expect(parsed.owner).toBe(USER)
  expect(parsed.dacl).toMatchObject({ protected: false })
  expect(parsed.dacl!.aces[0]).toEqual({ type: "A", flags: ["OI", "CI"], rights: 0x1301bf, sid: OTHER })
  expect(parsed.dacl!.aces[2]).toMatchObject({ flags: ["OI", "CI", "ID"], rights: 0x1f01ff, sid: SYSTEM })
  expect(parsed.labels).toEqual([])
  expect(parseSddl("O:SYD:P(A;;GA;;;BA)").dacl).toEqual({
    protected: true,
    aces: [{ type: "A", flags: [], rights: 0x10000000, sid: ADMINISTRATORS }],
  })
  expect(parseSddl(realDrive).labels).toEqual([
    { type: "ML", flags: ["OI", "NP", "IO"], rights: 1, sid: "S-1-16-12288" },
  ])
  expect(parseSddl(`O:${USER}G:${USER}D:NO_ACCESS_CONTROL`).dacl).toBeNull()
  expect(parseSddl(`O:${USER}`).dacl).toBeUndefined()
  // Domain-relative and unknown aliases never equal a trusted SID.
  expect(parseSddl("O:DUD:(A;;FA;;;DA)").owner).toBe("alias:DU")
  for (const bad of [
    "",
    "garbage",
    `D:(A;;FA;;;SY`,
    "D:(A;;ZZ;;;SY)",
    "D:(A;;FA;;SY)",
    "O:SYO:SY",
    "D:Q(A;;FA;;;SY)",
    "D:(A;O;FA;;;SY)",
  ])
    expect(() => parseSddl(bad)).toThrow()
})

test("a private directory or file names only the principal and SYSTEM, with a Medium no-read-up label", () => {
  const check = (sddl: string) => privateDescriptorProblem(parseSddl(sddl), principal)
  expect(check(privateDirectorySddl(USER))).toBeUndefined()
  // A file created inside inherits both ACEs and the label.
  expect(check(`O:${USER}D:(A;ID;FA;;;${USER})(A;ID;FA;;;SY)S:AI(ML;ID;NWNR;;;ME)`)).toBeUndefined()
  // Deny ACEs only narrow access; a stronger label is fine.
  expect(check(`O:${USER}D:P(D;;FA;;;${OTHER})(A;;FA;;;${USER})S:(ML;;NWNR;;;HI)`)).toBeUndefined()
  // An elevated administrator's files are owned by Administrators.
  expect(
    privateDescriptorProblem(parseSddl(`O:BAD:P(A;;FA;;;${USER})`), {
      user: USER,
      owners: [USER, ADMINISTRATORS],
    }),
  ).toBeUndefined()
  expect(check(`O:${OTHER}D:P(A;;FA;;;${USER})`)).toBe("foreign owner")
  expect(check(`O:BAD:P(A;;FA;;;${USER})`)).toBe("foreign owner")
  expect(check(`O:${USER}`)).toBe("missing DACL")
  expect(check(`O:${USER}D:NO_ACCESS_CONTROL`)).toBe("missing DACL")
  // The installer's directory inherits the profile ACL: Administrators and others.
  expect(check(plainLocalAppData)).toBe("foreign access")
  expect(check(`O:${USER}D:P(A;ID;FR;;;BU)(A;;FA;;;${USER})`)).toBe("foreign access")
  expect(check(`O:${USER}D:P(OA;;FA;;;${USER})`)).toBe("unexpected ACE")
  expect(check(`O:${USER}D:P(A;;FA;;;${USER})S:(ML;;NWNR;;;LW)`)).toBe("weak integrity label")
  expect(check(`O:${USER}D:P(A;;FA;;;${USER})S:(ML;;NW;;;ME)`)).toBe("weak integrity label")
  expect(check(`O:${USER}D:P(A;;FA;;;${USER})S:(ML;;NWNR;;;${OTHER})`)).toBe("weak integrity label")
})

test("an ancestor is refused when another account could change, own or rename it", () => {
  const problem = (child: string, parent?: string) =>
    ancestorProblem(parseSddl(child), parent === undefined ? undefined : parseSddl(parent), USER)
  // Real chain: the drive root, Users and the profile pass; read and add-subdirectory grants are fine.
  expect(problem(realDrive)).toBeUndefined()
  expect(problem(realUsers, realDrive)).toBeUndefined()
  expect(problem(realProfile, realUsers)).toBeUndefined()
  expect(problem(plainLocalAppData, plainLocalAppData)).toBeUndefined()
  // Another account with DELETE on LocalAppData and add-file on AppData could swap it out.
  expect(problem(realAppData, realProfile)).toBeUndefined()
  expect(problem(realLocalAppData, realAppData)).toBe("foreign rename")
  // A private top directory below such a parent cannot be renamed: the grant is not inherited.
  expect(problem(privateDirectorySddl(USER), realLocalAppData)).toBeUndefined()
  expect(problem(`O:${OTHER}D:P(A;;FA;;;${USER})`)).toBe("foreign owner")
  expect(problem(`O:${USER}D:NO_ACCESS_CONTROL`)).toBe("missing DACL")
  expect(problem(`O:${USER}D:P(A;;WD;;;BU)`)).toBe("foreign control")
  expect(problem(`O:${USER}D:P(A;;WO;;;${OTHER})`)).toBe("foreign control")
  expect(problem(`O:${USER}D:P(A;;GA;;;WD)`)).toBe("foreign control")
  expect(problem(`O:${USER}D:P(A;;FA;;;${USER})`, `O:${USER}D:P(A;;0x46;;;BU)`)).toBe("foreign rename")
  expect(problem(`O:${USER}D:P(A;;FA;;;${USER})`, `O:${USER}D:NO_ACCESS_CONTROL`)).toBe("foreign rename")
  // Inherit-only grants do not apply to the directory itself.
  expect(problem(`O:${USER}D:P(A;OICIIO;GA;;;BU)`)).toBeUndefined()
})

test("lockdown must read back exactly the owner, the protected user-only DACL and the Medium label", () => {
  expect(lockedPipeSddl(USER)).toBe(`O:${USER}D:P(A;;GA;;;${USER})S:(ML;;NWNR;;;ME)`)
  const problem = (sddl: string) => lockedPipeProblem(parseSddl(sddl), USER)
  expect(problem(lockedPipe)).toBeUndefined()
  expect(problem(lockedPipeSddl(USER))).toBeUndefined()
  expect(problem(defaultPipe)).toBe("unexpected DACL")
  expect(problem(`O:${OTHER}D:P(A;;FA;;;${USER})S:(ML;;NWNR;;;ME)`)).toBe("foreign owner")
  expect(problem(`O:${USER}D:(A;;FA;;;${USER})S:(ML;;NWNR;;;ME)`)).toBe("unexpected DACL")
  expect(problem(`O:${USER}D:P(A;;FR;;;${USER})S:(ML;;NWNR;;;ME)`)).toBe("unexpected DACL")
  expect(problem(`O:${USER}D:P(A;;FA;;;${USER})(A;;FR;;;WD)S:(ML;;NWNR;;;ME)`)).toBe("unexpected DACL")
  expect(problem(`O:${USER}D:P(A;;FA;;;${USER})`)).toBe("unexpected label")
  expect(problem(`O:${USER}D:P(A;;FA;;;${USER})S:(ML;;NW;;;ME)`)).toBe("unexpected label")
  expect(problem(`O:${USER}D:P(A;;FA;;;${USER})S:(ML;;NWNR;;;HI)`)).toBe("unexpected label")
})

test("only Medium, or High and System with UAC off, may run or attach to a daemon", () => {
  const table: [number, number | undefined, string | undefined][] = [
    [MEDIUM_INTEGRITY, 1, undefined],
    [MEDIUM_INTEGRITY, undefined, undefined],
    [0x2100, 1, undefined],
    [HIGH_INTEGRITY, 0, undefined],
    [0x4000, 0, undefined],
    [HIGH_INTEGRITY, 1, "elevated with UAC on"],
    [HIGH_INTEGRITY, undefined, "elevated with UAC on"],
    [0x4000, 1, "elevated with UAC on"],
    [0x1000, 0, "low integrity"],
    [0, 0, "low integrity"],
  ]
  for (const [rid, lua, expected] of table)
    expect([rid, lua, integrityProblem(rid, lua)]).toEqual([rid, lua, expected])
})
