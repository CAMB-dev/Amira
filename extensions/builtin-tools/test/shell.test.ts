import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  bashFromGitExecPath,
  findGitBash,
  gitBashEnv,
  gitBashLayout,
  isRejectedShellPath,
  powershellShell,
  resolveShell,
} from "../src/shell.ts"

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

test("maps Git's bin/bash.exe launcher to usr/bin/bash.exe", () => {
  const exists = fakeFs("D:/G/usr/bin/bash.exe")
  const layout = (p: string) => {
    const { bash, root } = gitBashLayout(p, exists)
    return { bash: norm(bash), root: root && norm(root) }
  }
  expect(layout("D:/G/bin/bash.exe")).toEqual({ bash: "D:/G/usr/bin/bash.exe", root: "D:/G" })
  expect(layout("D:/G/usr/bin/bash.exe")).toEqual({ bash: "D:/G/usr/bin/bash.exe", root: "D:/G" })
  expect(layout("E:/custom/bash.exe")).toEqual({ bash: "E:/custom/bash.exe", root: undefined })
})

test("gives bash the environment Git's launcher would", () => {
  const env = gitBashEnv("D:/G", { Path: "C:/Windows", MSYSTEM: "UCRT64" }, "C:/Users/me")
  expect(norm(env.Path!)).toBe("D:/G/mingw64/bin;D:/G/usr/bin;C:/Users/me/bin;C:/Windows")
  expect(env.PATH).toBeUndefined()
  expect(env.MSYSTEM).toBe("UCRT64")
  expect(gitBashEnv("D:/G", {}, "C:/Users/me").MSYSTEM).toBe("MINGW64")
})

const shell = await resolveShell()
const gated = shell.kind === "bash" && shell.gated

test.if(gated)(
  "a gated command runs only after a line arrives on stdin",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "amira-gate-"))
    try {
      const marker = join(dir, "ran").replaceAll("\\", "/")
      const proc = Bun.spawn(shell.args(`echo > "${marker}"`), {
        env: shell.env,
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      })
      await Bun.sleep(1500)
      expect(existsSync(marker)).toBe(false)
      proc.stdin.write("\n")
      await proc.stdin.end()
      expect(await proc.exited).toBe(0)
      expect(existsSync(marker)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
  30_000,
)

test.if(process.platform === "win32")(
  "PowerShell fallback passes the command through intact",
  async () => {
    const ps = powershellShell()
    // Embedded quotes, a trailing backslash before a quote, a literal $ and a PowerShell backtick escape.
    const command = "Write-Output 'a\"b' \"c d\" 'e\\f\\' '$x' \"g`\"h\""
    const proc = Bun.spawn(ps.args(command), { stdout: "pipe", stderr: "pipe" })
    const out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    expect(out.split(/\r?\n/).filter(Boolean)).toEqual(['a"b', "c d", "e\\f\\", "$x", 'g"h'])
    expect(ps.label).toContain("PowerShell")
  },
  30_000,
)

test("finds Git Bash from git.exe on PATH without running git", async () => {
  const exists = fakeFs("D:/Tools/Git/usr/bin/bash.exe")
  let ranGit = false
  const found = await findGitBash({
    env: {},
    exists,
    which: () => "D:/Tools/Git/cmd/git.exe",
    gitExecPath: async () => {
      ranGit = true
      return undefined
    },
  })
  expect(norm(found!)).toBe("D:/Tools/Git/usr/bin/bash.exe")
  expect(ranGit).toBe(false)
})
