import { expect, test } from "bun:test"
import { join } from "node:path"
import { bashFromGitExecPath, findGitBash, isRejectedShellPath } from "../src/shell.ts"

const norm = (p: string) => p.replaceAll("\\", "/")
const fakeFs = (...files: string[]) => {
  const set = new Set(files.map(norm))
  return (p: string) => set.has(norm(p))
}

test("rejects WSL and Store aliases", () => {
  expect(isRejectedShellPath("C:\\Windows\\System32\\bash.exe")).toBe(true)
  expect(isRejectedShellPath("C:/Users/me/AppData/Local/Microsoft/WindowsApps/bash.exe")).toBe(true)
  expect(isRejectedShellPath("D:\\DevSDKs\\Git\\bin\\bash.exe")).toBe(false)
})

test("derives Git Bash from git --exec-path", () => {
  const exists = fakeFs("D:/DevSDKs/Git/usr/bin/bash.exe")
  expect(norm(bashFromGitExecPath("D:/DevSDKs/Git/mingw64/libexec/git-core", exists)!)).toBe(
    "D:/DevSDKs/Git/usr/bin/bash.exe",
  )
  const both = fakeFs("D:/G/bin/bash.exe", "D:/G/usr/bin/bash.exe")
  expect(norm(bashFromGitExecPath("D:/G/mingw64/libexec/git-core", both)!)).toBe("D:/G/bin/bash.exe")
})

test("AMIRA_BASH wins, but never a System32 path", async () => {
  const exists = fakeFs("E:/custom/bash.exe", "C:/Windows/System32/bash.exe", "D:/G/bin/bash.exe")
  const gitExecPath = async () => "D:/G/mingw64/libexec/git-core"
  expect(await findGitBash({ env: { AMIRA_BASH: "E:/custom/bash.exe" }, exists, gitExecPath })).toBe(
    "E:/custom/bash.exe",
  )
  const found = await findGitBash({
    env: { AMIRA_BASH: "C:/Windows/System32/bash.exe" },
    exists,
    gitExecPath,
  })
  expect(norm(found!)).toBe("D:/G/bin/bash.exe")
})

test("falls back to common install paths, then gives up", async () => {
  const gitExecPath = async () => undefined
  const env = { ProgramFiles: "C:\\Program Files" }
  const exists = fakeFs(join("C:\\Program Files", "Git", "bin", "bash.exe"))
  expect(norm((await findGitBash({ env, exists, gitExecPath }))!)).toBe("C:/Program Files/Git/bin/bash.exe")
  expect(await findGitBash({ env: {}, exists: () => false, gitExecPath })).toBeUndefined()
})
