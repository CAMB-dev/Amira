import { mock } from "bun:test"
import * as fs from "node:fs/promises"
import path from "node:path"

// Isolated process: do not leak a builtin-module mock into the rest of the test suite.
const actual = { ...fs }
const storageRoot = await actual.realpath(process.argv[2]!)
const dir = path.join(storageRoot, "owned", "outputs")
const other = path.join(storageRoot, "other", "outputs")
const id = "a_1234567890"
const metadata = path.join(dir, `${id}.json`)
await actual.mkdir(dir, { recursive: true })
await actual.mkdir(other, { recursive: true })
await actual.writeFile(metadata, JSON.stringify({ id, chars: 1 }))
await actual.writeFile(path.join(other, `${id}.json`), JSON.stringify({ id, chars: 1 }))
let replaced = false
mock.module("node:fs/promises", () => ({
  ...actual,
  lstat: async (file: Parameters<typeof fs.lstat>[0]) => {
    const info = await actual.lstat(file)
    if (file === metadata && !replaced) {
      replaced = true
      await actual.rename(dir, `${dir}.original`)
      await actual.symlink(other, dir, process.platform === "win32" ? "junction" : "dir")
    }
    return info
  },
}))
const { ArtifactStore } = await import("../src/artifacts.ts")
const store = new ArtifactStore({ dir, storageRoot, sessionId: "s" })
try {
  await store.resolveOwned(id)
} catch (error) {
  if (replaced && error instanceof Error && error.message.includes("metadata")) process.exit(0)
  throw error
}
throw new Error("Metadata replacement granted artifact authority")
