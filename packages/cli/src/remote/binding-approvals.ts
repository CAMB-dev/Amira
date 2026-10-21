import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { ProviderBindingApproval } from "./provider-bindings.ts"

type Identity = ProviderBindingApproval & { remoteOrigin?: string }

/** Local user consent only. Store digests, never resolved URLs/headers/keys or remote-supplied paths. */
export class BindingApprovals {
  private directory: string
  constructor(home: string, authority: string, workspace: string) {
    const namespace = createHash("sha256")
      .update(JSON.stringify([authority, workspace]))
      .digest("hex")
    this.directory = path.join(home, "remote", "bindings", namespace)
  }
  private file(identity: Identity) {
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          identity.provider,
          identity.dialect,
          identity.localProvider,
          identity.endpointOrigin,
          identity.remoteOrigin,
        ]),
      )
      .digest("hex")
    return path.join(this.directory, `${key}.json`)
  }
  async approved(identity: Identity, fingerprint: string): Promise<boolean> {
    try {
      const file = this.file(identity)
      const info = await lstat(file)
      if (!info.isFile() || info.size > 1024) return false
      const receipt = JSON.parse(await readFile(file, "utf8"))
      return receipt?.schema === 1 && receipt.fingerprint === fingerprint
    } catch {
      return false
    }
  }
  async remember(identity: Identity, fingerprint: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Invalid local approval receipt")
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify({ schema: 1, fingerprint })}\n`, {
        flag: "wx",
        mode: 0o600,
      })
      await rename(temporary, this.file(identity))
    } finally {
      await rm(temporary, { force: true })
    }
  }
}
