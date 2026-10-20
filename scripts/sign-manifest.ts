import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  verify,
} from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { type BuildMetadata, type Target, targets, validateBuildMetadata } from "./build-metadata.ts"

export { type BuildMetadata, validateBuildMetadata as validateMetadata } from "./build-metadata.ts"

// No timestamps: identical archives and build metadata must produce identical signed bytes.
export async function generateManifest(directory: string, metadata?: BuildMetadata) {
  const build = validateBuildMetadata(
    metadata ?? JSON.parse(await readFile(path.join(directory, "build.json"), "utf8")),
  )
  const artifacts = []
  for (const target of [...build.targets].sort()) {
    const file = `amira-${target}.${target.startsWith("bun-windows-") ? "zip" : "tar.gz"}`
    const bytes = await readFile(path.join(directory, file))
    artifacts.push({
      target,
      file,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })
  }
  return `${JSON.stringify({ version: build.version, channel: build.channel, artifacts }, null, 2)}\n`
}

function privateKey(pem: string) {
  if (!pem.startsWith("-----BEGIN PRIVATE KEY-----")) throw new Error("Expected an Ed25519 PKCS8 PEM key")
  const key = createPrivateKey(pem)
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Expected an Ed25519 private key")
  return key
}

export function signManifest(bytes: Uint8Array, pem: string) {
  return sign(null, bytes, privateKey(pem)).toString("base64")
}

async function signingKey(options: Map<string, string>): Promise<KeyObject> {
  if (["--key", "--key-env", "--ephemeral"].filter((flag) => options.has(flag)).length !== 1) {
    throw new Error("Choose exactly one key source: --key, --key-env, or --ephemeral true")
  }
  if (options.has("--ephemeral")) {
    if (options.get("--ephemeral") !== "true") throw new Error("Ephemeral signing requires --ephemeral true")
    // Never export the private key: dry-run signing keeps it entirely in memory.
    return generateKeyPairSync("ed25519").privateKey
  }
  const variable = options.get("--key-env")
  if (variable !== undefined) {
    const pem = process.env[variable]
    if (!pem) throw new Error(`Missing private key in environment variable ${variable}`)
    return privateKey(pem)
  }
  return privateKey(await readFile(options.get("--key")!, "utf8"))
}

export function verifyManifest(bytes: Uint8Array, signature: string, pem: string) {
  const key = createPublicKey(pem)
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Expected an Ed25519 public key")
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature.trim())) return false
  return verify(null, bytes, key, Buffer.from(signature.trim(), "base64"))
}

export async function manifestCommand(
  argv: string[],
  manifestName: "manifest.json" | "server-manifest.json" = "manifest.json",
) {
  const command = argv[0]
  const allowed: Record<string, readonly string[]> = {
    generate: ["--dist", "--version", "--channel", "--target"],
    keygen: ["--dist", "--key"],
    sign: ["--dist", "--key", "--key-env", "--ephemeral"],
    verify: ["--dist", "--public-key", "--key-env"],
  }
  const options = new Map<string, string>()
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i]!
    const value = argv[i + 1]
    if (!allowed[command ?? ""]?.includes(flag) || !value || value.startsWith("--") || options.has(flag)) {
      throw new Error(`Invalid manifest option: ${flag}`)
    }
    options.set(flag, value)
  }
  const directory = options.get("--dist") ?? "dist"
  const manifest = path.join(directory, manifestName)
  const signature = path.join(directory, `${manifestName}.sig`)
  if (command === "generate") {
    let metadata: BuildMetadata | undefined
    if (["--version", "--channel", "--target"].some((flag) => options.has(flag))) {
      metadata = {
        version: options.get("--version") ?? "",
        channel: options.get("--channel") as BuildMetadata["channel"],
        targets: (options.get("--target") === "all"
          ? [...targets]
          : options.get("--target")?.split(",")) as Target[],
      }
    }
    await writeFile(manifest, await generateManifest(directory, metadata))
  } else if (command === "keygen") {
    const file = options.get("--key")
    if (!file) throw new Error("keygen requires --key (private key output path)")
    const keys = generateKeyPairSync("ed25519", {
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    })
    await writeFile(file, keys.privateKey, { mode: 0o600, flag: "wx" })
    console.log(keys.publicKey)
  } else if (command === "sign") {
    const key = await signingKey(options)
    await writeFile(signature, `${sign(null, await readFile(manifest), key).toString("base64")}\n`)
    console.log(createPublicKey(key).export({ type: "spki", format: "pem" }).toString())
  } else if (command === "verify") {
    if (["--public-key", "--key-env"].filter((flag) => options.has(flag)).length !== 1) {
      throw new Error("verify requires exactly one of --public-key or --key-env")
    }
    const file = options.get("--public-key")
    const pem = file
      ? await readFile(file, "utf8")
      : createPublicKey(await signingKey(options))
          .export({ type: "spki", format: "pem" })
          .toString()
    if (!verifyManifest(await readFile(manifest), await readFile(signature, "utf8"), pem)) {
      throw new Error("Manifest signature verification failed")
    }
  } else {
    throw new Error("Usage: sign-manifest.ts generate|sign|verify|keygen [options]")
  }
}

if (import.meta.main) await manifestCommand(process.argv.slice(2))
