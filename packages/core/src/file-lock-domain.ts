import { createHash } from "node:crypto"
import { readFileSync, readlinkSync } from "node:fs"
import os from "node:os"

export interface LeaseDomain {
  platform: NodeJS.Platform
  host: string | null
  legacyHost: string | null
  boot: string | null
  pidNamespace: string | null
}

function hostHash(platform: string, hostname: string, machine: string): string {
  return createHash("sha256").update(`${platform}\n${hostname}\n${machine}`).digest("hex")
}

export function windowsHostIdentity(
  hostname: string,
  interfaces: ReturnType<typeof os.networkInterfaces>,
): { host: string | null; legacyHost: string | null } {
  const macs = Object.entries(interfaces)
    .filter(([name]) => !/tunnel|loopback|teredo|isatap|6to4/i.test(name))
    .flatMap(([, addresses]) => addresses ?? [])
    .filter((address) => !address.internal)
    .map((address) => address.mac.toLowerCase())
    .filter(
      (mac) =>
        /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(mac) &&
        mac !== "00:00:00:00:00:00" &&
        (Number.parseInt(mac.slice(0, 2), 16) & 0x03) === 0,
    )
  const machine = [...new Set(macs)].sort().join(",")
  const legacyMachine = adapterIdentity(interfaces)
  return {
    host: machine ? hostHash("win32", hostname, machine) : null,
    legacyHost: legacyMachine ? hostHash("win32", hostname, legacyMachine) : null,
  }
}

function adapterIdentity(interfaces: ReturnType<typeof os.networkInterfaces>): string | undefined {
  return (
    Object.values(interfaces)
      .flatMap((addresses) => addresses ?? [])
      .filter((address) => !address.internal && address.mac !== "00:00:00:00:00:00")
      .map((address) => address.mac)
      .filter((mac, index, all) => all.indexOf(mac) === index)
      .sort()
      .join(",") || undefined
  )
}

export function localDomain(): LeaseDomain {
  const domain: LeaseDomain = {
    platform: process.platform,
    host: null,
    legacyHost: null,
    boot: null,
    pidNamespace: null,
  }
  try {
    if (process.platform === "win32") {
      return { ...domain, ...windowsHostIdentity(os.hostname(), os.networkInterfaces()) }
    }
    let machine: string | undefined
    if (process.platform === "linux") {
      try {
        machine = readFileSync("/etc/machine-id", "utf8").trim() || undefined
      } catch {}
      domain.boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null
      domain.pidNamespace = readlinkSync("/proc/self/ns/pid") || null
      if (!domain.boot || !domain.pidNamespace) return domain
    }
    machine ??= adapterIdentity(os.networkInterfaces())
    domain.host = machine ? hostHash(process.platform, os.hostname(), machine) : null
  } catch {}
  return domain
}
