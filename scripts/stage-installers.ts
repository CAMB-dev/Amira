import { createPublicKey } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { releasePublicKey } from "../packages/cli/src/update/public-key.ts"

/** Release installers pin exactly the same public key as the compiled updater. */
export async function stageInstallers(
  directory = "dist",
  publicKey = releasePublicKey,
  root = path.resolve(import.meta.dir, ".."),
) {
  if (publicKey && createPublicKey(publicKey).asymmetricKeyType !== "ed25519") {
    throw new Error("Expected an Ed25519 release public key")
  }
  await mkdir(directory, { recursive: true })
  for (const name of ["install.sh", "install.ps1"]) {
    const source = await readFile(path.join(root, name), "utf8")
    const placeholder = name === "install.sh" ? "public_key=''" : "$publicKey = ''"
    if (!source.includes(`${placeholder} # AMIRA_RELEASE_PUBLIC_KEY`)) {
      throw new Error(`Missing release public key placeholder in ${name}`)
    }
    // PEM contains only ASCII delimiters, base64 and line breaks; no shell interpolation.
    const key = publicKey ? createPublicKey(publicKey).export({ type: "spki", format: "pem" }).toString() : ""
    await writeFile(
      path.join(directory, name),
      source.replace(placeholder, placeholder.replace("''", `'${key}'`)),
    )
  }
}

if (import.meta.main) await stageInstallers(process.argv[2])
