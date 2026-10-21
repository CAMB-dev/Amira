// Compiled fixtures cannot import bun:test's offline preload. Install the same guards here.
import dns from "node:dns"
import net from "node:net"

const deny = (): never => {
  throw new Error("Networking is forbidden in native remote smoke fixtures")
}
globalThis.fetch = Object.assign(deny, { preconnect: deny })
Bun.connect = deny
Bun.listen = deny
net.Socket.prototype.connect = deny
dns.lookup = Object.assign(deny, { __promisify__: deny })

// Test-only native identity: not a production Linux server artifact or deployment claim.
export const smokeRelease = {
  version: "0.0.0",
  buildId: "development-b14-native-smoke",
  target: "bun-windows-x64",
}
export const smokePrompt = "B14 remote native prompt"
export const smokeAnswer = "B14 native mock answer"
