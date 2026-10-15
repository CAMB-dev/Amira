import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { bumpedVersion, releaseVersion, syncVersion } from "./version-sync.ts"

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test("release tags accept only canonical stable and rc versions", () => {
  expect(releaseVersion("v1.2.3")).toBe("1.2.3")
  expect(releaseVersion("v1.2.3-rc.4")).toBe("1.2.3-rc.4")
  for (const tag of [
    "1.2.3",
    "v01.2.3",
    "v1.2.3-rc.01",
    "v1.2.3-beta.1",
    "v1.2.3+meta",
    "v1.2.3\n",
    "v1.2.3/evil",
  ]) {
    expect(() => releaseVersion(tag)).toThrow()
  }
})

test("version bumps and explicit tag sync use the same release version grammar", () => {
  expect(bumpedVersion("1.2.3", "patch")).toBe("1.2.4")
  expect(bumpedVersion("1.2.3", "minor")).toBe("1.3.0")
  expect(bumpedVersion("1.2.3", "major")).toBe("2.0.0")
  expect(bumpedVersion("1.2.3", "rc")).toBe("1.2.3-rc.1")
  expect(bumpedVersion("1.2.3-rc.2", "rc")).toBe("1.2.3-rc.3")
  expect(bumpedVersion("1.2.3-rc.2", "v1.2.3")).toBe("1.2.3")
  expect(() => bumpedVersion("1.2.3", "nightly")).toThrow()
})

test("sync changes only CLI source and lockfile versions, preserves layout, and check never writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amira-version-"))
  temporary.push(root)
  await mkdir(path.join(root, "packages/cli"), { recursive: true })
  const cli = path.join(root, "packages/cli/package.json")
  const unrelated = path.join(root, "package.json")
  await writeFile(cli, '{"name":"amira","version":"0.1.0","private":true}\n')
  await writeFile(unrelated, '{"private":true}\n')
  const lockfile = path.join(root, "bun.lock")
  const lock =
    '{\n  "workspaces": {\n    "packages/cli": { "name": "amira", "version": "0.1.0", },\n    "packages/core": { "version": "0.0.0", },\n  },\n}\n'
  await writeFile(lockfile, lock)
  expect(await syncVersion(["sync", "v1.2.3-rc.1"], root)).toBe("1.2.3-rc.1")
  const before = await readFile(cli, "utf8")
  expect(before).toBe('{"name":"amira","version":"1.2.3-rc.1","private":true}\n')
  const syncedLock = lock.replace("0.1.0", "1.2.3-rc.1")
  expect(await readFile(lockfile, "utf8")).toBe(syncedLock)
  expect(await syncVersion(["check", "v1.2.3-rc.1"], root)).toBe("1.2.3-rc.1")
  await expect(syncVersion(["check", "v1.2.3"], root)).rejects.toThrow("does not match")
  expect(await readFile(cli, "utf8")).toBe(before)
  expect(await readFile(unrelated, "utf8")).toBe('{"private":true}\n')
  expect(JSON.parse(before)).toEqual({ name: "amira", version: "1.2.3-rc.1", private: true })
  expect(await readFile(lockfile, "utf8")).toBe(syncedLock)
  await writeFile(lockfile, lock)
  await expect(syncVersion(["check", "v1.2.3-rc.1"], root)).rejects.toThrow("bun.lock CLI version")
  expect(await syncVersion(["bump", "rc"], root)).toBe("1.2.3-rc.2")
  expect(await readFile(lockfile, "utf8")).toBe(lock.replace("0.1.0", "1.2.3-rc.2"))
})
