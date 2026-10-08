import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { runCommand } from "@amira/proc"
import { loadAuth, restrictToCurrentUser } from "../src/config/auth.ts"
import { SettingsError } from "../src/config/schema.ts"
import { setAuthKey, updateProviderInSettings } from "../src/config/write.ts"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "amira-provider-config-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const read = (file: string) => JSON.parse(readFileSync(file, "utf8"))

test("updating a provider replaces or removes just that entry and keeps the rest", () => {
  const file = path.join(dir, "settings.json")
  writeFileSync(
    file,
    JSON.stringify({ model: "a/m", providers: { a: { dialect: "x", baseUrl: "u" } }, other: 1 }),
  )
  const r = updateProviderInSettings(file, "b", (cur) => {
    expect(cur).toBeUndefined()
    return { dialect: "openai-chat", baseUrl: "https://b" }
  })
  expect(r).toEqual({ after: { dialect: "openai-chat", baseUrl: "https://b" } })
  updateProviderInSettings(file, "a", (cur) => ({ ...cur, baseUrl: "v" }))
  expect(read(file)).toEqual({
    model: "a/m",
    providers: { a: { dialect: "x", baseUrl: "v" }, b: { dialect: "openai-chat", baseUrl: "https://b" } },
    other: 1,
  })
  const removed = updateProviderInSettings(file, "a", () => undefined)
  expect(removed.before).toEqual({ dialect: "x", baseUrl: "v" })
  expect(Object.keys(read(file).providers)).toEqual(["b"])
  // No change, no write: a file that cannot be replaced is not touched.
  const before = statSync(file).mtimeMs
  updateProviderInSettings(file, "b", (cur) => cur)
  expect(statSync(file).mtimeMs).toBe(before)
  writeFileSync(file, "{ broken")
  expect(() => updateProviderInSettings(file, "c", () => ({}))).toThrow(SettingsError)
  expect(readFileSync(file, "utf8")).toBe("{ broken")
})

test("auth keys are stored and removed one provider at a time, owner-only on POSIX", () => {
  const file = path.join(dir, "auth.json")
  expect(setAuthKey(file, "a", "sk-a")).toBe(true)
  expect(setAuthKey(file, "b", "sk-b")).toBe(true)
  expect(setAuthKey(file, "a", "sk-a")).toBe(false)
  expect(setAuthKey(file, "a", "sk-a2")).toBe(true)
  expect(read(file)).toEqual({
    a: { type: "api_key", apiKey: "sk-a2" },
    b: { type: "api_key", apiKey: "sk-b" },
  })
  expect(loadAuth(file, process.platform).keys).toEqual({ a: "sk-a2", b: "sk-b" })
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(setAuthKey(file, "a", undefined)).toBe(true)
  expect(setAuthKey(file, "zz", undefined)).toBe(false)
  expect(read(file)).toEqual({ b: { type: "api_key", apiKey: "sk-b" } })
})

test("setting an auth key adds its type to legacy or unsupported entries and keeps other entries", () => {
  const file = path.join(dir, "auth.json")
  writeFileSync(
    file,
    JSON.stringify({
      legacy: { apiKey: "sk-legacy" },
      future: { type: "oauth", apiKey: "sk-future" },
      untouched: { apiKey: "sk-other" },
    }),
  )
  expect(setAuthKey(file, "legacy", "sk-legacy")).toBe(true)
  expect(setAuthKey(file, "future", "sk-future")).toBe(true)
  expect(read(file)).toEqual({
    legacy: { type: "api_key", apiKey: "sk-legacy" },
    future: { type: "api_key", apiKey: "sk-future" },
    untouched: { apiKey: "sk-other" },
  })
  expect(setAuthKey(file, "legacy", "sk-legacy")).toBe(false)
  expect(loadAuth(file, "win32")).toEqual({
    keys: { legacy: "sk-legacy", future: "sk-future", untouched: "sk-other" },
    warnings: [],
  })
})

test("restrictToCurrentUser runs icacls for the current user on Windows only", async () => {
  const seen: string[][] = []
  const run = async (argv: string[]) => {
    seen.push(argv)
    return { exitCode: 0, output: "" }
  }
  expect(await restrictToCurrentUser("/x/auth.json", { platform: "linux", run })).toBeUndefined()
  expect(seen).toEqual([])
  const env = { USERNAME: "ada", USERDOMAIN: "PC" }
  expect(await restrictToCurrentUser("C:\\u\\auth.json", { platform: "win32", env, run })).toBeUndefined()
  expect(seen[0]).toEqual(["icacls", "C:\\u\\auth.json", "/inheritance:r", "/grant:r", "PC\\ada:F"])
  const failing = async () => ({ exitCode: 1332, output: "No mapping between account names\r\n" })
  expect(await restrictToCurrentUser("f", { platform: "win32", env, run: failing })).toBe(
    "could not restrict f to your user (icacls: No mapping between account names)",
  )
  expect(await restrictToCurrentUser("f", { platform: "win32", env: {}, run })).toContain(
    "USERNAME is not set",
  )
})

test.skipIf(process.platform !== "win32")(
  "on Windows the ACL really leaves only the current user",
  async () => {
    const file = path.join(dir, "auth.json")
    setAuthKey(file, "a", "sk-a")
    expect(await restrictToCurrentUser(file)).toBeUndefined()
    const shown = await runCommand(["icacls", file], {
      cwd: dir,
      timeoutMs: 20_000,
      signal: new AbortController().signal,
      viaCmd: true,
    })
    const user = process.env.USERNAME!
    expect(shown.output).toContain(`${user}:(F)`)
    expect(shown.output).not.toContain("BUILTIN\\Users")
    expect(loadAuth(file).keys).toEqual({ a: "sk-a" })
  },
  60_000,
)
