/**
 * Network helpers for extensions that reach addresses the model or a page chooses, e.g. a
 * browser deciding which requests to let through, or the images a reply shows. `fetchPublic`
 * downloads with web_fetch's protection (no private-network addresses, every redirect checked,
 * the connection pinned to the checked address, a size limit): use it rather than fetch for any
 * URL a reply, a page or a file chose.
 *
 * The API owns these signatures; the host installs the implementation before loading extensions.
 */

/** A refusal or failure whose message can be shown as it is. */
export class NetError extends Error {}

/** Resolves a host name to all its addresses. Replaceable in tests. */
export type Resolver = (host: string) => Promise<string[]>

export interface GuardedFetchOptions {
  /** Skip the private-network check. Default false: such addresses are refused. */
  allowPrivateNetwork?: boolean
  /** Added to the refusal of a private address, e.g. the setting that allows them. */
  privateHint?: string
  headers?: Record<string, string>
  /** For tests: the network and name resolution. */
  fetch?: typeof fetch
  resolve?: Resolver
}

export interface GuardedResponse {
  response: Response
  /** Where the last redirect led. */
  url: URL
}

export interface PublicFetchOptions {
  /** The most bytes read; a larger body is refused ("too large"). */
  maxBytes: number
  signal: AbortSignal
  /** Sent with the request, e.g. `accept`. */
  headers?: Record<string, string>
  /** Content types taken: others are refused before the body is read. Default any. */
  types?: RegExp
  /** For tests: the network and name resolution. */
  fetch?: typeof fetch
  resolve?: Resolver
}

export interface PublicFetchResult {
  bytes: Uint8Array
  /** The response's Content-Type, "" without one. */
  contentType: string
  /** Where the last redirect led. */
  url: string
}

export interface HostNetService {
  fetchPublic(url: string, opts: PublicFetchOptions): Promise<PublicFetchResult>
  guardedFetch(start: URL, opts: GuardedFetchOptions, signal: AbortSignal): Promise<GuardedResponse>
  isPrivateAddress(ip: string): boolean
  parseHttpUrl(raw: string): URL
  readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }>
  /** Identifies the host implementation's NetError so the API can preserve its public error type. */
  isNetError(error: unknown): boolean
}

let hostNet: HostNetService | undefined

/** @internal Called by the host before it loads any extension. */
export function installHostNet(service: HostNetService): void {
  hostNet = service
}

function requireHostNet(): HostNetService {
  if (!hostNet) {
    throw new Error(
      "Amira's host network service has not been installed: the host installs it before loading extensions",
    )
  }
  return hostNet
}

function normalizedError(service: HostNetService, error: unknown): unknown {
  if (!service.isNetError(error)) return error
  return new NetError(error instanceof Error ? error.message : String(error), { cause: error })
}

function callHost<T>(operation: (service: HostNetService) => T): T {
  const service = requireHostNet()
  try {
    return operation(service)
  } catch (error) {
    throw normalizedError(service, error)
  }
}

async function callHostAsync<T>(operation: (service: HostNetService) => Promise<T>): Promise<T> {
  const service = requireHostNet()
  try {
    return await operation(service)
  } catch (error) {
    throw normalizedError(service, error)
  }
}

export function fetchPublic(url: string, opts: PublicFetchOptions): Promise<PublicFetchResult> {
  return callHostAsync((service) => service.fetchPublic(url, opts))
}

export function guardedFetch(
  start: URL,
  opts: GuardedFetchOptions,
  signal: AbortSignal,
): Promise<GuardedResponse> {
  return callHostAsync((service) => service.guardedFetch(start, opts, signal))
}

export function isPrivateAddress(ip: string): boolean {
  return callHost((service) => service.isPrivateAddress(ip))
}

export function parseHttpUrl(raw: string): URL {
  return callHost((service) => service.parseHttpUrl(raw))
}

export function readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  return callHostAsync((service) => service.readCapped(res, max))
}
