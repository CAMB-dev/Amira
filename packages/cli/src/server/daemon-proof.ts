import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import type { RemoteIO } from "../remote/connection.ts"
import { RemoteError } from "../remote/errors.ts"
import { privateMessage, readPrivatePrelude } from "./private-ipc.ts"

/**
 * The connection could not prove it reached the daemon recorded in daemon.json. Nothing secret
 * was sent, so readiness retries it until its deadline, like a lost connection.
 */
export class DaemonProofError extends RemoteError {
  constructor() {
    super("disconnected", "The daemon connection could not be verified")
    this.name = "DaemonProofError"
  }
}

const challenge = /^[0-9a-f]{64}$/
const mac = (key: string, role: "server" | "client", endpoint: string, client: string, server: string) =>
  createHmac("sha256", key).update(`amira-daemon/${role}\0${endpoint}\0${client}\0${server}`).digest()

function sameMac(expected: Buffer, value: unknown): boolean {
  if (typeof value !== "string" || !challenge.test(value)) return false
  return timingSafeEqual(expected, Buffer.from(value, "hex"))
}

function exactKeys(value: unknown, keys: string): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { auth?: unknown }).auth === 1 &&
    Object.keys(value).sort().join(",") === keys
  )
}

/**
 * Client half of the mutual proof keyed by the daemon's nonce, bound to the endpoint name and
 * both fresh challenges. The client sends nothing derived from the key until the server has
 * proven it knows the key. Returns the connection positioned after the proof.
 */
export async function proveToDaemon(io: RemoteIO, endpoint: string, key: string): Promise<RemoteIO> {
  try {
    const client = randomBytes(32).toString("hex")
    await privateMessage(io, { auth: 1, c: client })
    const { value, tail } = await readPrivatePrelude(io)
    if (!exactKeys(value, "auth,p,s") || typeof value.s !== "string" || !challenge.test(value.s))
      throw new DaemonProofError()
    if (!sameMac(mac(key, "server", endpoint, client, value.s), value.p)) throw new DaemonProofError()
    await privateMessage(io, { auth: 1, p: mac(key, "client", endpoint, client, value.s).toString("hex") })
    return tail
  } catch {
    // Early EOF, a timeout, a malformed or wrong reply are all the same unverified daemon.
    throw new DaemonProofError()
  }
}

/** Server half: throws on any failure; the caller closes the connection without a reason. */
export async function proveClient(io: RemoteIO, endpoint: string, key: string): Promise<RemoteIO> {
  const first = await readPrivatePrelude(io)
  const request = first.value
  if (!exactKeys(request, "auth,c") || typeof request.c !== "string" || !challenge.test(request.c))
    throw new Error("Invalid daemon proof request")
  const server = randomBytes(32).toString("hex")
  await privateMessage(io, {
    auth: 1,
    s: server,
    p: mac(key, "server", endpoint, request.c, server).toString("hex"),
  })
  const second = await readPrivatePrelude(first.tail)
  if (
    !exactKeys(second.value, "auth,p") ||
    !sameMac(mac(key, "client", endpoint, request.c, server), second.value.p)
  )
    throw new Error("Invalid daemon proof")
  return second.tail
}
