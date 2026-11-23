import { setUserAgentVersion } from "@amira/core"
import { version } from "./version.ts"

export const USER_AGENT = `Amira/${version}`

// Web requests, including extension API helpers, share the host's application version.
setUserAgentVersion(version)
