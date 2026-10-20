import { afterEach, expect, spyOn, test } from "bun:test"
import { createHash, generateKeyPairSync } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { stageNpmPackages } from "./npm-pack.ts"
import {
  type ServerBuildMetadata,
  serverArtifact,
  serverTargets,
  validateServerMetadata,
} from "./server-build-metadata.ts"
import {
  generateServerChecksums,
  generateServerManifest,
  recoverServerMetadata,
  serverManifestCommand,
} from "./server-manifest.ts"
import { generateManifest, verifyManifest } from "./sign-manifest.ts"

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
const build: ServerBuildMetadata = {
  product: "amira-server",
  version: "1.2.3",
  buildId: "0123456789abcdef0123456789abcdef01234567",
  channel: "stable",
  targets: [...serverTargets],
}
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "amira-server-manifest-"))
  temporary.push(directory)
  for (const name of ["local-home", "remote-home", "workspace"]) await mkdir(path.join(directory, name))
  await writeFile(path.join(directory, "server-build.json"), JSON.stringify(build))
  for (const target of serverTargets)
    await writeFile(path.join(directory, serverArtifact(target)), `raw ${target}`)
  await writeFile(path.join(directory, "SERVER_SHA256SUMS"), await generateServerChecksums(directory, build))
  return directory
}

test("server metadata rejects wrong products, unsafe versions, duplicate and unsupported targets", () => {
  for (const value of [
    { ...build, product: "amira" },
    { ...build, product: undefined },
    { ...build, version: "../bad" },
    ...[
      undefined,
      "",
      "1.2.3",
      "abcdef0",
      "../bad",
      "a".repeat(41),
      `${build.buildId}\n`,
      "development-",
      "development-../bad",
    ].map((buildId) => ({ ...build, buildId })),
    { ...build, targets: ["bun-linux-x64"] },
    { ...build, targets: ["bun-windows-x64"] },
    { ...build, targets: [] },
    { ...build, targets: [serverTargets[0], serverTargets[0]] },
  ])
    expect(() => validateServerMetadata(value)).toThrow()
})

test("deterministic server manifest signs raw executable sizes and hashes, not CLI archives", async () => {
  const directory = await fixture()
  await writeFile(path.join(directory, "amira-bun-linux-x64.tar.gz"), "unrelated CLI archive")
  const text = await generateServerManifest(directory)
  expect(await generateServerManifest(directory, { ...build, targets: [...build.targets].reverse() })).toBe(
    text,
  )
  const manifest = JSON.parse(text)
  expect(manifest.product).toBe("amira-server")
  expect(manifest.buildId).toBe(build.buildId)
  expect(manifest.artifacts).toHaveLength(2)
  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(path.join(directory, artifact.file))
    expect(artifact.size).toBe(bytes.length)
    expect(artifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
    expect(artifact.file).not.toMatch(/\.(zip|gz)$/)
  }
  await writeFile(path.join(directory, serverArtifact(serverTargets[0])), "")
  await expect(generateServerManifest(directory)).rejects.toThrow("Empty server artifact")
})

test("server signing and verification keep CLI manifests unchanged", async () => {
  const directory = await fixture()
  await writeFile(path.join(directory, "manifest.json"), "CLI manifest")
  await writeFile(path.join(directory, "manifest.json.sig"), "CLI signature")
  const keys = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  })
  const key = path.join(directory, "fixture-private.pem")
  const publicKey = path.join(directory, "fixture-public.pem")
  await writeFile(key, keys.privateKey)
  await writeFile(publicKey, keys.publicKey)
  await serverManifestCommand(["generate", "--dist", directory])
  const log = spyOn(console, "log").mockImplementation(() => {})
  try {
    await serverManifestCommand(["sign", "--dist", directory, "--key", key])
    await serverManifestCommand(["verify", "--dist", directory, "--public-key", publicKey])
  } finally {
    log.mockRestore()
  }
  const bytes = await readFile(path.join(directory, "server-manifest.json"))
  const signature = await readFile(path.join(directory, "server-manifest.json.sig"), "utf8")
  expect(verifyManifest(bytes, signature, keys.publicKey)).toBe(true)
  expect(
    verifyManifest(
      Buffer.from(bytes.toString().replace(build.buildId, "f".repeat(40))),
      signature,
      keys.publicKey,
    ),
  ).toBe(false)
  expect(verifyManifest(Buffer.concat([bytes, Buffer.from(" ")]), signature, keys.publicKey)).toBe(false)
  expect(await readFile(path.join(directory, "manifest.json"), "utf8")).toBe("CLI manifest")
  expect(await readFile(path.join(directory, "manifest.json.sig"), "utf8")).toBe("CLI signature")
})

test("immutable recovery validates full expected metadata and identical raw bytes without rewriting manifests", async () => {
  const directory = await fixture()
  const manifest = await generateServerManifest(directory)
  await writeFile(path.join(directory, "server-manifest.json"), manifest)
  await writeFile(path.join(directory, "server-manifest.json.sig"), "immutable signature")
  await rm(path.join(directory, "server-build.json"))
  await serverManifestCommand([
    "recover",
    "--dist",
    directory,
    "--version",
    build.version,
    "--channel",
    build.channel,
    "--target",
    "all",
    "--build-id",
    build.buildId,
  ])
  expect(JSON.parse(await readFile(path.join(directory, "server-build.json"), "utf8"))).toEqual(build)
  expect(await readFile(path.join(directory, "server-manifest.json"), "utf8")).toBe(manifest)
  expect(await readFile(path.join(directory, "server-manifest.json.sig"), "utf8")).toBe("immutable signature")
  await expect(recoverServerMetadata(directory, { ...build, version: "1.2.4" })).rejects.toThrow(
    "Published server manifest",
  )
  await expect(recoverServerMetadata(directory, { ...build, buildId: "f".repeat(40) })).rejects.toThrow(
    "Published server manifest",
  )
  await expect(recoverServerMetadata(directory, { ...build, channel: "next" })).rejects.toThrow(
    "Published server manifest",
  )
  await expect(recoverServerMetadata(directory, { ...build, targets: [serverTargets[0]] })).rejects.toThrow(
    "Published server manifest",
  )
  await writeFile(path.join(directory, "SERVER_SHA256SUMS"), "changed checksum")
  await expect(recoverServerMetadata(directory, build)).rejects.toThrow("Published server checksums")
  await writeFile(path.join(directory, serverArtifact(serverTargets[0])), "changed executable")
  await expect(recoverServerMetadata(directory, build)).rejects.toThrow("Published server manifest")
})

test("server files do not contaminate CLI manifests or npm platform packages", async () => {
  const directory = await fixture()
  await writeFile(
    path.join(directory, "build.json"),
    JSON.stringify({ version: "4.5.6", channel: "stable", targets: ["bun-linux-x64-baseline"] }),
  )
  await writeFile(path.join(directory, "amira-bun-linux-x64-baseline.tar.gz"), "CLI archive")
  await mkdir(path.join(directory, "amira-bun-linux-x64-baseline"))
  await writeFile(path.join(directory, "amira-bun-linux-x64-baseline", "amira"), "CLI executable")
  const manifest = JSON.parse(await generateManifest(directory))
  expect(manifest.version).toBe("4.5.6")
  expect(manifest.artifacts.map((artifact: { file: string }) => artifact.file)).toEqual([
    "amira-bun-linux-x64-baseline.tar.gz",
  ])
  const staged = await stageNpmPackages({ dist: directory, targets: ["bun-linux-x64-baseline"] })
  expect(staged.version).toBe("4.5.6")
  expect(staged.packages.map((item) => item.name).sort()).toEqual(["amira", "amira-linux-x64"])
  expect(await readFile(path.join(directory, "npm/amira-linux-x64/bin/amira"), "utf8")).toBe("CLI executable")
  const main = JSON.parse(await readFile(path.join(directory, "npm/amira/package.json"), "utf8"))
  expect(Object.keys(main.optionalDependencies)).toHaveLength(5)
  expect(JSON.stringify(main)).not.toContain("amira-server")
})

test("explicit manifest and recovery metadata require a validated build identity", async () => {
  const directory = await fixture()
  const argv = [
    "--dist",
    directory,
    "--version",
    build.version,
    "--channel",
    build.channel,
    "--target",
    "all",
  ]
  for (const command of ["generate", "recover"]) {
    await expect(serverManifestCommand([command, ...argv])).rejects.toThrow("Invalid server build identity")
    await expect(serverManifestCommand([command, ...argv, "--build-id", build.version])).rejects.toThrow(
      "Invalid server build identity",
    )
  }
  await serverManifestCommand(["generate", ...argv, "--build-id", build.buildId])
  expect(JSON.parse(await readFile(path.join(directory, "server-manifest.json"), "utf8")).buildId).toBe(
    build.buildId,
  )
  expect(validateServerMetadata({ ...build, buildId: "development-local-fixture" }).buildId).toBe(
    "development-local-fixture",
  )
})
