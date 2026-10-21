import "../server/offline.ts"
import { expect, test } from "bun:test"
import { assertDaemonCompatibility, compatibleRemoteDaemon } from "../../src/remote/install.ts"
import { serverVersionIdentity } from "../../src/remote/release-identity.ts"
import { welcome } from "./loopback.ts"

test("compatible v1 active daemons drain in place; missing capabilities fail without destructive takeover", () => {
  const installed = { ...welcome.release, buildId: "installed-build" }
  const running = {
    ...welcome,
    capabilities: [
      "frontend.v1",
      "replay",
      "controller",
      "mutation.ledger",
      "files",
      "images",
      "jobs",
      "conversations",
      "model.proxy",
    ],
  }
  expect(assertDaemonCompatibility(running, installed, compatibleRemoteDaemon)).toEqual({
    replacementPending: true,
  })
  expect(() =>
    assertDaemonCompatibility(
      { ...running, capabilities: running.capabilities.filter((capability) => capability !== "frontend.v1") },
      installed,
      compatibleRemoteDaemon,
    ),
  ).toThrow("No running work was stopped")
  expect(() => assertDaemonCompatibility(running, installed, compatibleRemoteDaemon, "remote-key")).toThrow(
    "remote model keys",
  )
})

test("same-commit incompatibility reports both release versions, not an indistinguishable pair of hashes", () => {
  const installed = { ...welcome.release, version: "1.0.0", buildId: "a".repeat(40) }
  const running = { ...welcome, release: { ...installed, version: "1.0.0-next.1" } }
  expect(() => assertDaemonCompatibility(running, installed)).toThrow(`Server 1.0.0 (${installed.buildId})`)
  expect(() => assertDaemonCompatibility(running, installed)).toThrow(
    `daemon 1.0.0-next.1 (${installed.buildId})`,
  )
})

test("the installer and settings-free executable use the same canonical identity, independent of field order", () => {
  const release = { target: "bun-linux-arm64", buildId: "fixture", version: "0.1.0" }
  expect(JSON.stringify(serverVersionIdentity(release))).toBe(
    '{"product":"amira-server","version":"0.1.0","buildId":"fixture","target":"bun-linux-arm64"}',
  )
})
