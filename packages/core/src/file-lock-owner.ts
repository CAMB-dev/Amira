import { randomUUID } from "node:crypto"
import { type LeaseDomain, localDomain } from "./file-lock-domain.ts"

interface Owner {
  v: 2
  pid: number
  nonce: string
  createdAt: number
  host: string | null
  boot: string | null
  pidNamespace: string | null
}

const domain = localDomain()

export function leaseOwner(): Owner {
  const { host, boot, pidNamespace } = domain
  return { v: 2, pid: process.pid, nonce: randomUUID(), createdAt: Date.now(), host, boot, pidNamespace }
}

type OwnerState = "live" | "dead" | "unknown"

/** The same classification powers recovery and diagnostics; a message never grants authority. */
function inspectOwner(
  value: unknown,
  local: LeaseDomain,
  probe: (pid: number) => OwnerState,
): { state: OwnerState; reason?: string } {
  if (typeof value !== "object" || value === null) return { state: "unknown" }
  const owner = value as Partial<Owner>
  if (owner.v !== 2) return { state: "unknown" }
  if (
    !Number.isSafeInteger(owner.pid) ||
    owner.pid! <= 0 ||
    typeof owner.nonce !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(owner.nonce) ||
    !Number.isSafeInteger(owner.createdAt) ||
    owner.createdAt! <= 0
  )
    return { state: "unknown", reason: "unverifiable owner record: PID, nonce or creation time is invalid" }
  const sameHost =
    typeof owner.host === "string" &&
    owner.host.length > 0 &&
    (owner.host === local.host || (local.platform === "win32" && owner.host === local.legacyHost))
  if (!sameHost)
    return {
      state: "unknown",
      reason:
        "host identity mismatch: lease host hash does not match; verify the originating hostname and hardware MACs against trusted records",
    }
  // A boot mismatch excludes a PID domain. It never proves a previous owner dead:
  // another live clone can share installation identity while having a different boot.
  if (owner.boot !== local.boot)
    return {
      state: "unknown",
      reason: "unverifiable boot: lease and local boot identities differ or proof is missing",
    }
  if (owner.pidNamespace !== local.pidNamespace)
    return { state: "unknown", reason: "unverifiable PID domain: PID namespaces differ or proof is missing" }
  const state = owner.pid === process.pid ? "live" : probe(owner.pid!)
  return {
    state,
    ...(state === "dead"
      ? {}
      : {
          reason:
            state === "live"
              ? `live PID: owner ${owner.pid} is running or its PID probe is access-denied`
              : `live or unprobeable PID: cannot prove owner ${owner.pid} has exited`,
        }),
  }
}

/** Unknown host, PID domain, record or probe result must never authorize recovery. */
export function ownerState(
  value: unknown,
  local = domain,
  probe: (pid: number) => OwnerState = probePid,
): OwnerState {
  return inspectOwner(value, local, probe).state
}

/** Do not repeat a PID probe merely to explain a failed acquisition or identity recheck. */
export function ownerRecoveryFailure(
  value: unknown,
  local = domain,
  probe: (pid: number) => OwnerState = () => "unknown",
): string | undefined {
  return inspectOwner(value, local, probe).reason
}

function probePid(pid: number): OwnerState {
  try {
    process.kill(pid, 0)
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
