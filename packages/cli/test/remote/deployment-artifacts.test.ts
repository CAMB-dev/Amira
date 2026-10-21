import "../server/offline.ts"
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  directoryServerArtifacts,
  releaseServerArtifacts,
  verifyServerBundle,
  verifyServerManifest,
} from "../../src/remote/artifacts.ts"
import { parseRemoteCommand, runRemoteCommand } from "../../src/remote/command.ts"
import { ATTACH_SCRIPT, INSTALL_SCRIPT, PROBE_SCRIPT } from "../../src/remote/deployment-scripts.ts"
import { quoteShell, sshArgv, validateSshHost } from "../../src/remote/ssh.ts"
import { decodeRemoteTarget, RemoteTargetStore } from "../../src/remote/targets.ts"
import {
  deploymentBinary,
  deploymentFixture,
  deploymentPublicKey,
  deploymentRelease,
  deploymentTarget,
  shellWords,
  signedBundle,
} from "./deployment-fixture.ts"

test("server bundles authenticate exact signed bytes and raw size/hash, role, target and explicit build", () => {
  const bundle = signedBundle()
  const verify = (value = bundle) =>
    verifyServerBundle(value, deploymentPublicKey, deploymentRelease, deploymentTarget)
  expect(verify().release).toEqual({ ...deploymentRelease, target: deploymentTarget })
  expect(() => verify({ ...bundle, signature: `${"A".repeat(86)}==` })).toThrow("signature")
  expect(() => verify({ ...bundle, manifest: Buffer.from(`${Buffer.from(bundle.manifest)} `) })).toThrow(
    "signature",
  )
  expect(() => verify({ ...bundle, binary: Buffer.from("tampered") })).toThrow("SHA-256")
  expect(() => verify(signedBundle({ product: "amira" }))).toThrow("metadata")
  expect(() => verify(signedBundle({ buildId: "development-unrelated" }))).toThrow("build identity")
  expect(() => verify(signedBundle({ buildId: "0.1.0" }))).toThrow("build identity")
  expect(() => verifyServerManifest(bundle.manifest, bundle.signature, "")).toThrow("trusted")
  const artifact = JSON.parse(Buffer.from(bundle.manifest).toString("utf8")).artifacts[0]
  expect(() => verify(signedBundle({ artifacts: [artifact, artifact] }))).toThrow("targets")
  expect(() => verify(signedBundle({ artifacts: [{ ...artifact, file: "../amira" }] }))).toThrow("artifact")
  expect(() => verify(signedBundle({ artifacts: [{ ...artifact, size: 0 }] }))).toThrow("artifact")
  expect(() => verify(signedBundle({ artifacts: [{ ...artifact, sha256: "Z".repeat(64) }] }))).toThrow(
    "artifact",
  )
})

test("verified artifact owns its bytes; local directories use server-specific manifests", async () => {
  const fixture = await deploymentFixture()
  try {
    const directory = path.join(fixture.root, "bundle")
    await mkdir(directory)
    const bytes = Buffer.from(deploymentBinary)
    const bundle = signedBundle({}, bytes)
    await writeFile(path.join(directory, "server-manifest.json"), bundle.manifest)
    await writeFile(path.join(directory, "server-manifest.json.sig"), bundle.signature)
    await writeFile(path.join(directory, `amira-server-${deploymentTarget}`), bytes)
    const loaded = await directoryServerArtifacts(directory).load(deploymentTarget)
    const verified = verifyServerBundle(loaded, deploymentPublicKey, deploymentRelease, deploymentTarget)
    loaded.binary.fill(0)
    expect(verified.binary).toEqual(deploymentBinary)
  } finally {
    await fixture.dispose()
  }
})

test("release artifacts use verified local cache first and only the injected local download on a miss", async () => {
  const fixture = await deploymentFixture()
  try {
    const release = { ...deploymentRelease, buildId: "a".repeat(40) }
    const bundle = signedBundle(release)
    const requests: string[] = []
    const cacheDirectory = path.join(fixture.local, "cache")
    const source = releaseServerArtifacts({
      cacheDirectory,
      baseUrl: "https://offline.invalid/release",
      publicKey: deploymentPublicKey,
      release,
      async download(url, maximum) {
        requests.push(url)
        const bytes = url.endsWith(".sig")
          ? Buffer.from(bundle.signature)
          : url.endsWith(".json")
            ? bundle.manifest
            : bundle.binary
        expect(bytes.length).toBeLessThanOrEqual(maximum)
        return bytes
      },
    })
    expect((await source.load(deploymentTarget)).binary).toEqual(deploymentBinary)
    expect(requests).toEqual([
      "https://offline.invalid/release/server-manifest.json",
      "https://offline.invalid/release/server-manifest.json.sig",
      `https://offline.invalid/release/amira-server-${deploymentTarget}`,
    ])
    await source.load(deploymentTarget)
    expect(requests).toHaveLength(3)
    await writeFile(
      path.join(
        cacheDirectory,
        release.buildId,
        createHash("sha256").update(release.version).digest("hex"),
        deploymentTarget,
        `amira-server-${deploymentTarget}`,
      ),
      "corrupt cached executable",
    )
    expect((await source.load(deploymentTarget)).binary).toEqual(deploymentBinary)
    expect(requests).toHaveLength(6)
    let downloads = 0
    const invalid = releaseServerArtifacts({
      cacheDirectory: path.join(fixture.local, "bad-cache"),
      baseUrl: "https://offline.invalid/release",
      publicKey: deploymentPublicKey,
      release,
      download: async (url) => {
        downloads++
        return url.endsWith(".sig") ? Buffer.from(`${"A".repeat(86)}==`) : bundle.manifest
      },
    })
    await expect(invalid.load(deploymentTarget)).rejects.toThrow("signature")
    expect(downloads).toBe(2) // never even obtains executable bytes from an unverified manifest
  } finally {
    await fixture.dispose()
  }
})

test("signed stable and nightly versions of one commit remain independently available offline", async () => {
  const fixture = await deploymentFixture()
  try {
    const buildId = "b".repeat(40)
    const cacheDirectory = path.join(fixture.local, "shared-cache")
    const sources = [
      { version: "0.1.0", channel: "stable" },
      { version: "0.1.1-next.20261020", channel: "next" },
    ].map(({ version, channel }) => {
      const release = { version, buildId }
      const bundle = signedBundle({ ...release, channel }, Buffer.from(version))
      let offline = false
      return {
        bundle,
        disconnect() {
          offline = true
        },
        source: releaseServerArtifacts({
          cacheDirectory,
          baseUrl: `https://offline.invalid/${version}`,
          publicKey: deploymentPublicKey,
          release,
          async download(url) {
            if (offline) throw new Error("Release download unavailable")
            return url.endsWith(".sig")
              ? Buffer.from(bundle.signature)
              : url.endsWith(".json")
                ? bundle.manifest
                : bundle.binary
          },
        }),
      }
    })
    for (const entry of sources) await entry.source.load(deploymentTarget)
    for (const entry of sources) entry.disconnect()
    for (const entry of sources)
      expect((await entry.source.load(deploymentTarget)).binary).toEqual(entry.bundle.binary)
  } finally {
    await fixture.dispose()
  }
})

test("development checkouts require an explicit local bundle without attempting a release download", async () => {
  const fixture = await deploymentFixture()
  try {
    const source = releaseServerArtifacts({
      cacheDirectory: fixture.local,
      baseUrl: "https://offline.invalid/release",
      publicKey: deploymentPublicKey,
      release: deploymentRelease,
      download: async () => {
        throw new Error("must not download")
      },
    })
    await expect(source.load(deploymentTarget)).rejects.toThrow("explicit signed --bundle")
  } finally {
    await fixture.dispose()
  }
})

test("OpenSSH gets one quoted fixed command, no PTY or forwarding, and no raw cwd", () => {
  for (const value of [
    "",
    "a'b",
    "a; touch sentinel",
    "$(echo x)",
    "`uname`",
    "path with spaces",
    "line\nbreak",
  ]) {
    expect(shellWords(`x ${quoteShell(value)}`)).toEqual(["x", value])
    const argv = sshArgv("user@alias", INSTALL_SCRIPT, [value])
    expect(shellWords(argv[6]!)).toEqual(["sh", "-c", INSTALL_SCRIPT, "amira-remote", value])
  }
  for (const host of [
    "-oProxyCommand=bad",
    "a b",
    "a\ncommand",
    "a\n",
    "a\r",
    "a;touch",
    "user@-host",
    "../host",
  ])
    expect(() => validateSshHost(host)).toThrow("SSH host")
  expect(validateSshHost("user@proxy-alias")).toBe("user@proxy-alias")
  expect(validateSshHost("[::1]")).toBe("[::1]")
  expect(() => quoteShell("a\0b")).toThrow("NUL")
  expect(PROBE_SCRIPT).toContain("sha256sum")
  expect(INSTALL_SCRIPT).toContain("trap cleanup EXIT")
  expect(INSTALL_SCRIPT.indexOf('"$binary" --self-check')).toBeLessThan(
    INSTALL_SCRIPT.indexOf('mv -Tf -- "$stage/launcher"'),
  )
  expect(INSTALL_SCRIPT).toContain('mkdir -m 700 "$lock"')
  expect(INSTALL_SCRIPT).toContain('[ ! -L "$1" ]')
  expect(ATTACH_SCRIPT).not.toContain("cwd")
  expect(ATTACH_SCRIPT).toContain('exec "$1" attach')
})

test("command parsing treats cwd as Linux data, accepts explicit consent, and rejects ambiguous options", () => {
  expect(parseRemoteCommand(["add", "alias", "--cwd", "/home/a'b", "--yes"])).toEqual({
    action: "add",
    target: "alias",
    cwd: "/home/a'b",
    acceptInstall: true,
  })
  for (const argv of [
    ["attach", "alias", "--name", "foo"],
    ["add", "alias", "--cwd", "C:\\temp"],
    ["add", "alias", "--cwd", "/tmp/a\n"],
    ["add", "alias", "--yes", "--accept-install"],
    ["add", "alias", "--unknown"],
    ["add", "alias", "--name", "../bad"],
  ])
    expect(() => parseRemoteCommand(argv)).toThrow()
})

test("target records validate schema and paths, save atomically, and cannot overwrite another host", async () => {
  const fixture = await deploymentFixture()
  try {
    const record = decodeRemoteTarget({
      schema: 1,
      name: "work",
      host: "fixture-host",
      workspace: "/workspace",
      home: "/home/remote",
      user: "remote-user",
      uid: 1000,
      installRoot: "/home/remote/.amira/remote",
      consent: { automaticUpdates: true, modelMode: "local-proxy" },
      release: { ...deploymentRelease, target: deploymentTarget },
    })
    const store = new RemoteTargetStore(fixture.local)
    await store.save(record)
    expect(await store.read("work")).toEqual(record)
    expect(await store.find("fixture-host")).toEqual(record)
    await store.save({ ...record, name: "CON", host: "device-name-host" })
    expect((await store.read("CON"))?.host).toBe("device-name-host")
    await expect(store.save({ ...record, host: "other-host" })).rejects.toThrow("another host")
    const contenders = await Promise.allSettled([
      store.save({ ...record, name: "race", host: "first-host" }),
      store.save({ ...record, name: "race", host: "second-host" }),
    ])
    expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const winner = await store.read("race")
    if (!winner) throw new Error("The winning target record was not saved")
    expect(["first-host", "second-host"]).toContain(winner.host)
    expect(() => decodeRemoteTarget({ ...record, schema: 2 })).toThrow("record")
    expect(() => decodeRemoteTarget({ ...record, installRoot: "/tmp/other" })).toThrow("record")
    expect(() => decodeRemoteTarget({ ...record, workspace: "relative" })).toThrow("absolute Linux path")
    await expect(store.read("../escape")).rejects.toThrow("target name")
    await expect(store.read("work\n")).rejects.toThrow("target name")
    let help = ""
    await runRemoteCommand(["help"], {
      ...fixture.dependencies,
      write: (text) => {
        help = text
      },
    })
    expect(help).toContain("--accept-install")
    expect(fixture.children).toHaveLength(0)
  } finally {
    await fixture.dispose()
  }
})
