import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

/** Resolves a host name to all its addresses. Replaceable in tests. */
export type Resolver = (host: string) => Promise<string[]>

export const dnsResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)

function ipv4Parts(ip: string): number[] | undefined {
  const parts = ip.split(".").map(Number)
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts
    : undefined
}

function privateIpv4([a, b, c]: number[]): boolean {
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 ||
    (a === 100 && b !== undefined && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) || // protocol assignments, documentation
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a !== undefined && a >= 224) // multicast, reserved, broadcast
  )
}

/** Expands an IPv6 address into its eight 16-bit groups. */
function ipv6Groups(ip: string): number[] | undefined {
  let s = ip.replace(/^\[|\]$/g, "").split("%")[0] as string
  // A trailing dotted IPv4 part (e.g. ::ffff:127.0.0.1) becomes two groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (v4) {
    const p = ipv4Parts(v4[1] as string)
    if (!p) return undefined
    s = `${s.slice(0, v4.index)}${((p[0] as number) * 256 + (p[1] as number)).toString(16)}:${((p[2] as number) * 256 + (p[3] as number)).toString(16)}`
  }
  const halves = s.split("::")
  if (halves.length > 2) return undefined
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 0) return undefined
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail].map((g) =>
    Number.parseInt(g, 16),
  )
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : undefined
}

/**
 * Whether an IP address is loopback, private, link-local or otherwise not on the public
 * internet. Anything unparseable counts as private.
 */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip.replace(/^\[|\]$/g, "").split("%")[0] as string)
  if (kind === 4) return privateIpv4(ipv4Parts(ip) as number[])
  const g = ipv6Groups(ip)
  if (kind !== 6 || !g) return true
  const [g0, , , , , g5] = g as [number, number, number, number, number, number, number, number]
  const embeddedV4 = [
    (g[6] as number) >> 8,
    (g[6] as number) & 255,
    (g[7] as number) >> 8,
    (g[7] as number) & 255,
  ]
  if (g.slice(0, 7).every((x) => x === 0)) return true // :: and ::1
  if (g.slice(0, 5).every((x) => x === 0) && g5 === 0xffff) return privateIpv4(embeddedV4) // IPv4-mapped
  if (g.slice(0, 6).every((x) => x === 0)) return privateIpv4(embeddedV4) // IPv4-compatible
  if (g0 === 0x64 && g[1] === 0xff9b) return privateIpv4(embeddedV4) // NAT64
  if (g0 === 0x2002) {
    const [h1, h2] = [g[1] as number, g[2] as number]
    return privateIpv4([h1 >> 8, h1 & 255, h2 >> 8]) // 6to4
  }
  return (
    (g0 & 0xfe00) === 0xfc00 || // unique local
    (g0 & 0xffc0) === 0xfe80 || // link-local
    (g0 & 0xffc0) === 0xfec0 || // site-local (deprecated)
    (g0 & 0xff00) === 0xff00 || // multicast
    g0 === 0x100 || // discard prefix 100::/64
    (g0 === 0x2001 && g[1] === 0xdb8) // documentation
  )
}

/** Rejects with the signal's reason when it aborts first; the lookup itself cannot be cancelled. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    const done = () => signal.removeEventListener("abort", onAbort)
    work.then(
      (v) => {
        done()
        resolve(v)
      },
      (e) => {
        done()
        reject(e)
      },
    )
  })
}

/**
 * Throws when a URL's host is, or resolves to, a private address. Host names are resolved
 * and every address must be public; they are returned so the caller can connect to one of
 * them. An IP literal returns undefined.
 */
export async function assertPublicHost(
  url: URL,
  resolve: Resolver,
  signal?: AbortSignal,
  /** Added to the refusal in parentheses, e.g. the setting that allows such addresses. */
  hint?: string,
): Promise<string[] | undefined> {
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase()
  const blocked = () =>
    new Error(
      `refusing to fetch ${url.host}: it is a local or private-network address${hint ? ` (${hint})` : ""}`,
    )
  if (!host || host === "localhost" || host.endsWith(".localhost")) throw blocked()
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw blocked()
    return undefined
  }
  let addresses: string[]
  try {
    addresses = await raceAbort(resolve(host), signal)
  } catch (err) {
    if (signal?.aborted) throw err
    throw new Error(`cannot resolve ${host}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!addresses.length) throw new Error(`cannot resolve ${host}`)
  if (addresses.some(isPrivateAddress)) throw blocked()
  return addresses
}
