/**
 * Network helpers for extensions that reach addresses the model or a page chooses, e.g. a
 * browser deciding which requests to let through, or the images a reply shows. `fetchPublic`
 * downloads with web_fetch's protection (no private-network addresses, every redirect checked,
 * the connection pinned to the checked address, a size limit): use it rather than fetch for any
 * URL a reply, a page or a file chose.
 */
export {
  fetchPublic,
  isPrivateAddress,
  NetError,
  type PublicFetchOptions,
  type PublicFetchResult,
  type Resolver,
} from "@amira/net"
