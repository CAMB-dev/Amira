import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import type { NetworkInterfaceInfo } from "node:os"
import { windowsHostIdentity } from "../src/file-lock-domain.ts"

function address(mac: string, internal = false): NetworkInterfaceInfo {
  return {
    address: "192.0.2.1",
    netmask: "255.255.255.0",
    family: "IPv4",
    mac,
    internal,
    cidr: "192.0.2.1/24",
  }
}

function hash(hostname: string, macs: string): string {
  return createHash("sha256").update(`win32\n${hostname}\n${macs}`).digest("hex")
}

const ethernet = address("00:11:22:33:44:55")
const wifi = address("04:aa:bb:cc:dd:ee")
const virtual = address("02:11:22:33:44:55")

test("Windows primary host survives virtual adapter addition and removal", () => {
  const before = windowsHostIdentity("workstation", { Ethernet: [ethernet] })
  const during = windowsHostIdentity("workstation", {
    Ethernet: [ethernet],
    "vEthernet (Default Switch)": [virtual],
  })
  const after = windowsHostIdentity("workstation", { Ethernet: [ethernet] })
  expect(before.host).toBe(hash("workstation", ethernet.mac))
  expect(during.host).toBe(before.host)
  expect(after.host).toBe(before.host)
  expect(during.legacyHost).not.toBe(before.legacyHost)
  expect(after.legacyHost).toBe(before.legacyHost)
})

test("Windows primary host sorts and deduplicates adapters across IP families", () => {
  const before = windowsHostIdentity("workstation", { Ethernet: [ethernet], WiFi: [wifi] })
  const reordered = windowsHostIdentity("workstation", {
    WiFi: [{ ...wifi, family: "IPv6", scopeid: 0 }, wifi],
    Unavailable: undefined,
    Ethernet: [ethernet, { ...ethernet, family: "IPv6", scopeid: 0 }],
  })
  expect(before.host).toBe(hash("workstation", `${ethernet.mac},${wifi.mac}`))
  expect(reordered).toEqual(before)
})

test("Windows primary host normalizes MAC casing before deduplication", () => {
  const lower = windowsHostIdentity("workstation", { WiFi: [wifi] })
  const mixed = windowsHostIdentity("workstation", {
    WiFi: [address(wifi.mac.toUpperCase()), wifi],
  })
  expect(mixed.host).toBe(lower.host)
  expect(mixed.legacyHost).toBe(hash("workstation", `${wifi.mac.toUpperCase()},${wifi.mac}`))
  expect(mixed.legacyHost).not.toBe(lower.legacyHost)
})

test("Windows hosts with cloned hostnames but different hardware MACs differ", () => {
  const before = windowsHostIdentity("cloned-hostname", { Ethernet: [ethernet] })
  const clone = windowsHostIdentity("cloned-hostname", { Ethernet: [address("00:11:22:33:44:56")] })
  expect(clone.host).not.toBe(before.host)
  expect(clone.legacyHost).not.toBe(before.legacyHost)
})

test("Windows host hashes include the hostname", () => {
  const before = windowsHostIdentity("workstation", { Ethernet: [ethernet] })
  const renamed = windowsHostIdentity("renamed", { Ethernet: [ethernet] })
  expect(renamed.host).not.toBe(before.host)
  expect(renamed.legacyHost).not.toBe(before.legacyHost)
})

test.each(["02", "06", "0a", "0e", "12", "52", "aa", "fa", "fe"])(
  "Windows primary excludes locally administered first octet %s",
  (octet) => {
    const result = windowsHostIdentity("workstation", {
      Ethernet: [address(`${octet}:11:22:33:44:55`)],
    })
    expect(result.host).toBeNull()
    expect(result.legacyHost).toBe(hash("workstation", `${octet}:11:22:33:44:55`))
  },
)

test("Windows primary checks administration bits only in the first MAC octet", () => {
  const mac = "04:02:ff:aa:fe:03"
  expect(windowsHostIdentity("workstation", { Ethernet: [address(mac)] }).host).toBe(hash("workstation", mac))
})

test.each([
  "00:00:00:00:00:00",
  "01:11:22:33:44:55",
  "03:11:22:33:44:55",
  "ff:ff:ff:ff:ff:ff",
  "00:11:22:33:44",
  "00:11:22:33:44:55:66",
  "00-11-22-33-44-55",
  "00:11:22:33:44:gg",
  "00:11:22:33:44:55\n",
  "",
])("Windows primary excludes zero, multicast or malformed MAC %j", (mac) => {
  expect(windowsHostIdentity("workstation", { Ethernet: [address(mac)] }).host).toBeNull()
})

test("Windows host hashes exclude internal entries", () => {
  expect(windowsHostIdentity("workstation", { Ethernet: [address(ethernet.mac, true)] })).toEqual({
    host: null,
    legacyHost: null,
  })
})

test.each([
  "Tunnel adapter Ethernet",
  "Loopback Pseudo-Interface 1",
  "Teredo Tunneling Pseudo-Interface",
  "isatap.example",
  "6TO4 Adapter",
])("Windows primary excludes named adapter %s even with a hardware-looking MAC", (name) => {
  const result = windowsHostIdentity("workstation", { [name]: [ethernet] })
  expect(result.host).toBeNull()
  expect(result.legacyHost).toBe(hash("workstation", ethernet.mac))
})

test("Windows legacy host exactly preserves the original full raw MAC set algorithm", () => {
  const upper = address(wifi.mac.toUpperCase())
  const malformed = address("legacy-raw-mac")
  const result = windowsHostIdentity("workstation", {
    WiFi: [upper, wifi, upper],
    Ethernet: [ethernet, { ...ethernet, family: "IPv6", scopeid: 0 }],
    Virtual: [virtual],
    "Tunnel adapter": [malformed],
    Loopback: [address("00:99:88:77:66:55", true)],
    Zero: [address("00:00:00:00:00:00")],
    Unavailable: undefined,
  })
  const originalMacSet = [ethernet.mac, virtual.mac, upper.mac, wifi.mac, malformed.mac].sort().join(",")
  expect(result.legacyHost).toBe(hash("workstation", originalMacSet))
  expect(result.host).toBe(hash("workstation", `${ethernet.mac},${wifi.mac}`))
})

test("Windows virtual-only setups retain a legacy host without a primary host", () => {
  expect(windowsHostIdentity("workstation", { Virtual: [virtual] })).toEqual({
    host: null,
    legacyHost: hash("workstation", virtual.mac),
  })
})

test("Windows empty MAC sets leave both host identities unknown", () => {
  expect(windowsHostIdentity("workstation", {})).toEqual({ host: null, legacyHost: null })
  expect(
    windowsHostIdentity("workstation", {
      Ethernet: [],
      Unavailable: undefined,
      Loopback: [address("00:11:22:33:44:55", true)],
      Zero: [address("00:00:00:00:00:00")],
    }),
  ).toEqual({ host: null, legacyHost: null })
})
