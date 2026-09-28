import { expect, test } from "bun:test"
import os from "node:os"
import { gitInfo } from "../src/git.ts"

test("reports repo root and branch inside a repository", async () => {
  const info = await gitInfo(import.meta.dir)
  expect(info.repoRoot).toBeTruthy()
  expect(typeof info.isWorktree).toBe("boolean")
})

test("returns nothing outside a repository", async () => {
  expect(await gitInfo(os.tmpdir())).toEqual({})
})
