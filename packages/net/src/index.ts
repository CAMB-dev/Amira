export { assertPublicHost, dnsResolver, isPrivateAddress, type Resolver } from "./address.ts"
export {
  type GuardedFetchOptions,
  type GuardedResponse,
  guardedFetch,
  NetError,
  parseHttpUrl,
  readCapped,
  USER_AGENT,
} from "./guarded-fetch.ts"
