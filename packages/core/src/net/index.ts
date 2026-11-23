import { installHostNet } from "@amira/api"
import { assertPublicHost, dnsResolver, isPrivateAddress, type Resolver } from "./address.ts"
import { fetchPublic, type PublicFetchOptions, type PublicFetchResult } from "./fetch-public.ts"
import {
  type GuardedFetchOptions,
  type GuardedResponse,
  guardedFetch,
  NetError,
  parseHttpUrl,
  readCapped,
  setUserAgentVersion,
  USER_AGENT,
} from "./guarded-fetch.ts"

installHostNet({
  fetchPublic,
  guardedFetch,
  isPrivateAddress,
  isNetError: (error) => error instanceof NetError,
  parseHttpUrl,
  readCapped,
})

export {
  assertPublicHost,
  dnsResolver,
  fetchPublic,
  type GuardedFetchOptions,
  type GuardedResponse,
  guardedFetch,
  isPrivateAddress,
  NetError,
  type PublicFetchOptions,
  type PublicFetchResult,
  parseHttpUrl,
  type Resolver,
  readCapped,
  setUserAgentVersion,
  USER_AGENT,
}
