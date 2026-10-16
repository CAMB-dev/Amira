import { afterEach, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { validateBuildMetadata } from "./build-metadata.ts"
import {
  generateManifest,
  manifestCommand,
  signManifest,
  validateMetadata,
  verifyManifest,
} from "./sign-manifest.ts"
import { SPAWN_TEST_TIMEOUT_MS, stopSpawn, waitForSpawnExit, waitForSpawnWork } from "./spawn-test.ts"

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "amira-manifest-"))
  temporary.push(dir)
  await writeFile(
    path.join(dir, "build.json"),
    JSON.stringify({
      version: "1.2.3-rc.1",
      channel: "next",
      targets: ["bun-linux-x64"],
    }),
  )
  await writeFile(path.join(dir, "amira-bun-linux-x64.tar.gz"), "archive bytes")
  return dir
}

test("manifest hashes only declared build archives and is deterministic", async () => {
  const dir = await fixture()
  await writeFile(path.join(dir, "unrelated.zip"), "stale archive")
  const manifest = await generateManifest(dir)
  expect(await generateManifest(dir)).toBe(manifest)
  expect(JSON.parse(manifest)).toEqual({
    version: "1.2.3-rc.1",
    channel: "next",
    artifacts: [
      {
        target: "bun-linux-x64",
        file: "amira-bun-linux-x64.tar.gz",
        size: 13,
        sha256: "cc9c340301ad4ba5e54aa24b442ff938d1ed84f7f32c4c5a73773c58af37bd1b",
      },
    ],
  })
})

test("manifest generation uses the shared metadata validator, including SemVer build suffixes", async () => {
  const dir = await fixture()
  expect(validateMetadata).toBe(validateBuildMetadata)
  const metadata = { version: "1.2.3-rc.1+build.007", channel: "next", targets: ["bun-linux-x64"] }
  await writeFile(path.join(dir, "build.json"), JSON.stringify(metadata))
  expect(JSON.parse(await generateManifest(dir)).version).toBe(metadata.version)
  await writeFile(path.join(dir, "build.json"), JSON.stringify({ ...metadata, targets: [] }))
  await expect(generateManifest(dir)).rejects.toThrow("Invalid build targets")
})

test("CLI metadata works without build.json and rejects unsafe or absent targets", async () => {
  const dir = await fixture()
  await rm(path.join(dir, "build.json"))
  await manifestCommand([
    "generate",
    "--dist",
    dir,
    "--version",
    "1.2.3",
    "--channel",
    "stable",
    "--target",
    "bun-linux-x64",
  ])
  expect(JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8")).version).toBe("1.2.3")
  await expect(generateManifest(dir, { version: "1.2.3", channel: "stable", targets: [] })).rejects.toThrow()
  await expect(manifestCommand(["generate", "--dist", dir, "--version", "../bad"])).rejects.toThrow()
  await expect(
    generateManifest(dir, { version: "1.2.3", channel: "stable", targets: ["bun-linux-arm64"] }),
  ).rejects.toThrow()
})

test("generated Ed25519 keys sign and verify exact bytes; tampering and other keys fail", async () => {
  const keys = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  })
  const bytes = Buffer.from(await generateManifest(await fixture()))
  const signature = signManifest(bytes, keys.privateKey)
  expect(verifyManifest(bytes, signature, keys.publicKey)).toBe(true)
  expect(verifyManifest(Buffer.concat([bytes, Buffer.from(" ")]), signature, keys.publicKey)).toBe(false)
  const tampered = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`
  expect(verifyManifest(bytes, tampered, keys.publicKey)).toBe(false)
  expect(verifyManifest(bytes, "bad signature", keys.publicKey)).toBe(false)
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()
  expect(verifyManifest(bytes, signature, other)).toBe(false)
  expect(() => signManifest(bytes, keys.publicKey)).toThrow("PKCS8")
  const wrongAlgorithm = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  })
  expect(() => signManifest(bytes, wrongAlgorithm.privateKey)).toThrow("Ed25519")
  expect(() => verifyManifest(bytes, signature, wrongAlgorithm.publicKey)).toThrow("Ed25519")
})

async function cli(directory: string, argv: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(
    [process.execPath, path.join(import.meta.dir, "sign-manifest.ts"), ...argv, "--dist", directory],
    {
      cwd: directory,
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  try {
    const [stdout, stderr, code] = await waitForSpawnWork(
      "child output",
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        waitForSpawnExit(child, "manifest CLI"),
      ]),
    )
    return { stdout, stderr, code }
  } finally {
    await stopSpawn(child)
  }
}

async function expectNoPrivateFiles(directory: string) {
  expect((await readdir(directory)).sort()).toEqual([
    "amira-bun-linux-x64.tar.gz",
    "build.json",
    "manifest.json",
    "manifest.json.sig",
    "public.pem",
  ])
  for (const name of await readdir(directory)) {
    expect(await readFile(path.join(directory, name), "utf8")).not.toContain("PRIVATE KEY")
  }
}

test(
  "CLI signs from an environment key and verifies retries without any private-key file",
  async () => {
    const dir = await fixture()
    await manifestCommand(["generate", "--dist", dir])
    const keys = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    })
    const env = { SIGNING_KEY_FIXTURE: keys.privateKey }
    const signed = await cli(dir, ["sign", "--key-env", "SIGNING_KEY_FIXTURE"], env)
    expect(signed.code).toBe(0)
    expect(signed.stderr).toBe("")
    expect(signed.stdout.trim()).toBe(keys.publicKey.trim())
    expect(signed.stdout).not.toContain("PRIVATE KEY")
    expect(signed.stderr).not.toContain(keys.privateKey)
    await writeFile(path.join(dir, "public.pem"), signed.stdout)
    expect(await cli(dir, ["verify", "--key-env", "SIGNING_KEY_FIXTURE"], env)).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    })
    expect((await cli(dir, ["verify", "--public-key", "public.pem"])).code).toBe(0)
    await expectNoPrivateFiles(dir)
    await writeFile(path.join(dir, "manifest.json"), "tampered")
    const tampered = await cli(dir, ["verify", "--key-env", "SIGNING_KEY_FIXTURE"], env)
    expect(tampered.code).not.toBe(0)
    expect(tampered.stderr).toContain("verification failed")
    expect(tampered.stderr).not.toContain(keys.privateKey)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "CLI ephemeral signing creates and discards its private key entirely in memory",
  async () => {
    const dir = await fixture()
    await manifestCommand(["generate", "--dist", dir])
    const signed = await cli(dir, ["sign", "--ephemeral", "true"])
    expect(signed.code).toBe(0)
    expect(signed.stderr).toBe("")
    expect(signed.stdout).toContain("BEGIN PUBLIC KEY")
    expect(signed.stdout).not.toContain("PRIVATE KEY")
    await writeFile(path.join(dir, "public.pem"), signed.stdout)
    expect((await cli(dir, ["verify", "--public-key", "public.pem"])).code).toBe(0)
    await expectNoPrivateFiles(dir)
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test(
  "CI key sources reject missing secrets, conflicting sources and invalid ephemeral requests",
  async () => {
    const dir = await fixture()
    await manifestCommand(["generate", "--dist", dir])
    for (const argv of [
      ["sign", "--key-env", "SIGNING_KEY_FIXTURE"],
      ["verify", "--key-env", "SIGNING_KEY_FIXTURE"],
      ["sign", "--key-env", "SIGNING_KEY_FIXTURE", "--key", "private.pem"],
      ["sign", "--key-env", "SIGNING_KEY_FIXTURE", "--ephemeral", "true"],
      ["sign", "--ephemeral", "false"],
    ]) {
      expect((await cli(dir, argv, { SIGNING_KEY_FIXTURE: "" })).code).not.toBe(0)
    }
    expect((await readdir(dir)).sort()).toEqual(["amira-bun-linux-x64.tar.gz", "build.json", "manifest.json"])
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test("CLI keygen refuses overwrite and sign/verify detects tampered manifests", async () => {
  const dir = await fixture()
  const key = path.join(dir, "private.pem")
  const pub = path.join(dir, "public.pem")
  await manifestCommand(["keygen", "--key", key])
  await expect(manifestCommand(["keygen", "--key", key])).rejects.toThrow()
  const { createPublicKey } = await import("node:crypto")
  await writeFile(pub, createPublicKey(await readFile(key, "utf8")).export({ type: "spki", format: "pem" }))
  await manifestCommand(["generate", "--dist", dir])
  await manifestCommand(["sign", "--dist", dir, "--key", key])
  expect((await readFile(path.join(dir, "manifest.json.sig"), "utf8")).trim()).toHaveLength(88)
  await manifestCommand(["verify", "--dist", dir, "--public-key", pub])
  await writeFile(path.join(dir, "manifest.json"), "tampered")
  await expect(manifestCommand(["verify", "--dist", dir, "--public-key", pub])).rejects.toThrow(
    "verification failed",
  )
})
