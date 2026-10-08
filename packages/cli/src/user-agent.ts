import { setUserAgentVersion } from "@amira/net"
import pkg from "../package.json" with { type: "json" }

export const USER_AGENT = `Amira/${pkg.version}`

// Web requests, including extension API helpers, share the host's application version.
setUserAgentVersion(pkg.version)
