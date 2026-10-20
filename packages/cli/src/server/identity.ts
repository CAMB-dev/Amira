import type { RemoteRelease } from "../remote/protocol.ts"
import { target, version } from "../version.ts"

declare const AMIRA_SERVER_BUILD_ID: string | undefined

/** Source runs must be visibly distinct from authenticated release artifacts. */
export const serverRelease: RemoteRelease = {
  version,
  target,
  buildId:
    typeof AMIRA_SERVER_BUILD_ID === "string"
      ? AMIRA_SERVER_BUILD_ID
      : process.env.AMIRA_SERVER_BUILD_ID || "development-unverified",
}
