import { createPublicKey } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

/** Accept a public SPKI PEM only; never derive a public key from private input. */
export function releaseKeySource(pem: string): string {
  if (!pem.trim().startsWith("-----BEGIN PUBLIC KEY-----"))
    throw new Error("Expected an Ed25519 public SPKI PEM, not a private key")
  const key = createPublicKey(pem)
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Expected an Ed25519 public key")
  const normalized = key.export({ type: "spki", format: "pem" }).toString()
  return `// Set only from a trusted Ed25519 public PEM with scripts/set-release-key.ts.\n// An empty key deliberately disables release update checks.\nexport const releasePublicKey =\n  ${JSON.stringify(normalized)}\n`
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length !== 1 || args[0]!.startsWith("-"))
    throw new Error("Usage: bun scripts/set-release-key.ts /trusted/path/release-public.pem")
  const output = path.resolve(import.meta.dir, "../packages/cli/src/update/public-key.ts")
  // This script only writes the committed public-key source, never a private key.
  await readFile(output, "utf8")
  await writeFile(output, releaseKeySource(await readFile(args[0]!, "utf8")))
  console.log("Release public key set. Review the diff and rebuild release binaries and install scripts.")
}
