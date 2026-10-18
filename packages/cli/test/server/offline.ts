import { afterAll, spyOn } from "bun:test"
import * as dns from "node:dns"
import * as net from "node:net"

const deny = () => {
  throw new Error("Networking is forbidden in server offline tests")
}
const guards = [
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(deny, { preconnect: deny })),
  spyOn(Bun, "connect").mockImplementation(deny),
  spyOn(Bun, "listen").mockImplementation(deny),
  spyOn(net.Socket.prototype, "connect").mockImplementation(deny),
  spyOn(dns, "lookup").mockImplementation(Object.assign(deny, { __promisify__: deny })),
]
for (const key of Object.keys(process.env)) if (key.startsWith("AMIRA_LIVE_")) delete process.env[key]
afterAll(() => {
  for (const guard of guards) guard.mockRestore()
})
