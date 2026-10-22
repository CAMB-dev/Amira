import { expect, spyOn, test } from "bun:test"
import type { LeaseDomain } from "../src/file-lock-domain.ts"
import { leaseOwner, ownerRecoveryFailure, ownerState } from "../src/file-lock-owner.ts"

const local: LeaseDomain = {
  platform: "win32",
  host: "hardware-host",
  legacyHost: "full-mac-host",
  boot: null,
  pidNamespace: null,
}
const owner = { ...leaseOwner(), host: local.host, boot: null, pidNamespace: null, pid: 424242 }

test.each(["live", "dead", "unknown"] as const)("matching-domain PID probe remains %s", (state) => {
  expect(ownerState(owner, local, () => state)).toBe(state)
})

test("the current process stays live without probing", () => {
  expect(ownerState({ ...owner, pid: process.pid }, local, () => "dead")).toBe("live")
})

test.each([1, Date.now()])(
  "matching Windows null boots retain baseline dead-PID recovery regardless of age (%d)",
  (createdAt) => {
    expect(ownerState({ ...owner, createdAt }, local, () => "dead")).toBe("dead")
  },
)

test.each(["win32", "linux", "darwin"] as const)(
  "%s boot mismatch never proves death or probes a foreign domain",
  (platform) => {
    let probes = 0
    expect(
      ownerState({ ...owner, boot: "another-boot", pid: process.pid }, { ...local, platform }, () => {
        probes++
        return "dead"
      }),
    ).toBe("unknown")
    expect(probes).toBe(0)
  },
)

test("legacy Windows full-MAC host requires the current full-set hash, not age or a dead PID alone", () => {
  const legacy = { ...owner, host: local.legacyHost }
  expect(ownerState(legacy, local, () => "dead")).toBe("dead")
  expect(ownerState(legacy, { ...local, legacyHost: "changed-full-mac-host" }, () => "dead")).toBe("unknown")
  expect(ownerState(legacy, { ...local, host: null }, () => "dead")).toBe("dead")
  expect(ownerState({ ...owner, host: null }, { ...local, host: null }, () => "dead")).toBe("unknown")
})

test("legacy Windows host compatibility never widens Linux's host domain", () => {
  expect(
    ownerState({ ...owner, host: local.legacyHost }, { ...local, platform: "linux" }, () => "dead"),
  ).toBe("unknown")
})

test.each([
  { host: "another-host" },
  { host: null },
  { host: "" },
  { boot: undefined },
  { boot: "" },
  { boot: 42 },
  { pidNamespace: "another-namespace" },
  { pidNamespace: undefined },
  { v: 1 },
  { createdAt: 0 },
  { nonce: "invalid" },
  { pid: 0 },
])("foreign or malformed owner fails closed: %j", (patch) => {
  expect(ownerState({ ...owner, ...patch }, local, () => "dead")).toBe("unknown")
})

test.each([
  ["ESRCH", "dead"],
  ["EPERM", "live"],
  ["EACCES", "unknown"],
] as const)("PID probe %s is classified as %s", (code, expected) => {
  const probe = spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("injected process probe"), { code })
  })
  try {
    expect(ownerState(owner, local)).toBe(expected)
    expect(probe).toHaveBeenCalledWith(owner.pid, 0)
  } finally {
    probe.mockRestore()
  }
})

test("recovery diagnostics never re-probe a PID after the authority check", () => {
  const probe = spyOn(process, "kill")
  try {
    expect(ownerRecoveryFailure(owner, local)).toContain("live or unprobeable PID")
    expect(probe).not.toHaveBeenCalled()
  } finally {
    probe.mockRestore()
  }
})

test.each([
  [{ ...owner, host: "another-host" }, "dead", "host identity mismatch"],
  [{ ...owner, boot: "another-boot" }, "dead", "unverifiable boot"],
  [owner, "live", "live PID"],
  [owner, "unknown", "unprobeable PID"],
] as const)("recovery diagnostic identifies the failed check (%j, %s)", (record, state, expected) => {
  expect(ownerRecoveryFailure(record, local, () => state)).toContain(expected)
})
