import { createHash, randomUUID } from "node:crypto"
import { readFileSync, readlinkSync } from "node:fs"
import os from "node:os"

interface Owner {
  v: 2
  pid: number
  nonce: string
  createdAt: number
  host: string | null
  boot: string | null
  pidNamespace: string | null
}

// A hostname alone is not same-host proof on a shared volume. Boot identity prevents
// reused Linux namespace inode numbers (or cloned machine IDs) from proving local death.
function localDomain(): Pick<Owner, "host" | "boot" | "pidNamespace"> {
  let machine: string | undefined
  let boot: string | null = null
  let pidNamespace: string | null = null
  try {
    if (process.platform === "linux") {
      try {
        machine = readFileSync("/etc/machine-id", "utf8").trim() || undefined
      } catch {}
      boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null
      pidNamespace = readlinkSync("/proc/self/ns/pid") || null
      if (!boot || !pidNamespace) return { host: null, boot, pidNamespace }
    }
    machine ??=
      Object.values(os.networkInterfaces())
        .flatMap((addresses) => addresses ?? [])
        .filter((address) => !address.internal && address.mac !== "00:00:00:00:00:00")
        .map((address) => address.mac)
        .filter((mac, index, all) => all.indexOf(mac) === index)
        .sort()
        .join(",") || undefined
    const host = machine
      ? createHash("sha256").update(`${process.platform}\n${os.hostname()}\n${machine}`).digest("hex")
      : null
    return { host, boot, pidNamespace }
  } catch {
    return { host: null, boot, pidNamespace }
  }
}
const domain = localDomain()

export function leaseOwner(): Owner {
  return { v: 2, pid: process.pid, nonce: randomUUID(), createdAt: Date.now(), ...domain }
}

/** Unknown host, PID domain, record or probe result must never authorize recovery. */
export function ownerState(value: unknown): "live" | "dead" | "unknown" {
  if (typeof value !== "object" || value === null) return "unknown"
  const owner = value as Partial<Owner>
  if (
    owner.v !== 2 ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid! <= 0 ||
    typeof owner.nonce !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(owner.nonce) ||
    !Number.isSafeInteger(owner.createdAt) ||
    owner.createdAt! <= 0 ||
    domain.host === null ||
    owner.host !== domain.host ||
    owner.boot !== domain.boot ||
    owner.pidNamespace !== domain.pidNamespace
  )
    return "unknown"
  // A nonce guards release, but cannot prove a live PID is not a reused PID. Block it.
  if (owner.pid === process.pid) return "live"
  try {
    process.kill(owner.pid!, 0)
    return "live"
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ESRCH" ? "dead" : code === "EPERM" ? "live" : "unknown"
  }
}

export function strictOwnerState(contents: string): ReturnType<typeof ownerState> {
  try {
    const [pid, nonce, record, trailing, ...extra] = contents.split("\n")
    const owner = JSON.parse(record!)
    if (pid !== String(owner.pid) || nonce !== owner.nonce || trailing !== "" || extra.length) {
      return "unknown"
    }
    return ownerState(owner)
  } catch {
    return "unknown"
  }
}
