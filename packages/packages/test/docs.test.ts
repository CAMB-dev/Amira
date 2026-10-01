import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { engineMismatch, readManifest } from "../src/index.ts"

// The package manifest shown next to the example extension in docs/extensions.md is one this
// package manager accepts. (packages/core/test/docs.test.ts loads and typechecks the code.)

const root = path.resolve(import.meta.dir, "../../..")

test("the example manifest in docs/extensions.md parses and matches this engine", () => {
  const manifest = readFileSync(path.join(root, "docs/extensions.md"), "utf8").match(
    /```json\n([\s\S]*?)\n```/,
  )![1]!
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-doc-manifest-"))
  try {
    writeFileSync(path.join(dir, "amira-package.json"), manifest)
    const parsed = readManifest(dir)
    expect(parsed.name).toBe("hello-extension")
    expect(engineMismatch(parsed)).toBeUndefined()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
