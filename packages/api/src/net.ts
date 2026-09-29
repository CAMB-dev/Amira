/**
 * Network helpers for extensions that reach addresses the model or a page chooses, e.g. a
 * browser deciding which requests to let through. Plain fetches of user-controlled URLs are
 * better left to the web tools, which also pin the checked address.
 */
export { isPrivateAddress } from "@amira/net"
