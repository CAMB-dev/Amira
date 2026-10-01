import { expect, test } from "bun:test"
import "../../../packages/core/src/index.ts"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cmdArgv, runCommand } from "../../../packages/proc/src/index.ts"
import {
  bashFromGitExecPath,
  fallbackPowerShell,
  findGitBash,
  gitBashEnv,
  gitBashLayout,
  isRejectedShellPath,
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
const gated = shell.kind === "bash" && shell.command(":", process.cwd()).gated

/** Starts a gated bash command directly or through cmd, and checks it waits for the gate line. */
async function checkGate(throughCmd: boolean, line: string | undefined, expectRan: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "amira-gate-"))
  try {
    const marker = join(dir, "ran").replaceAll("\\", "/")
    const { argv, env } = shell.command(`echo > "${marker}"; exit 4`, dir)
    const wrapped = throughCmd ? cmdArgv(argv, { cwd: dir, env, gated: true }) : argv
    expect(wrapped).toBeDefined()
    const proc = Bun.spawn(wrapped!, {
      cwd: dir,
      env,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      windowsVerbatimArguments: throughCmd,
    })
    await Bun.sleep(1500)
    expect(existsSync(marker)).toBe(false)
    if (line !== undefined) proc.stdin.write(`${line}\n`)
    await proc.stdin.end()
    expect(await proc.exited).toBe(expectRan ? 4 : 125)
    expect(existsSync(marker)).toBe(expectRan)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test.if(gated)(
  "a gated command runs only after a line arrives on stdin",
  () => checkGate(false, "", true),
  30_000,
)

test.if(gated)("a gated command does not run when stdin closes without a line", () =>
  checkGate(false, undefined, false),
)

test.if(gated)("through cmd, the gate is held by cmd", () => checkGate(true, "go", true), 30_000)

test.if(gated)(
  "through cmd, an empty or missing gate line runs nothing",
  async () => {
    await checkGate(true, "", false)
    await checkGate(true, undefined, false)
  },
  30_000,
)

test.if(process.platform === "win32")(
  "the PowerShell fallback is gated, labelled and passes the command through intact",
  async () => {
    const ps = fallbackPowerShell()
    // Embedded quotes, a trailing backslash before a quote, a literal $ and a PowerShell backtick escape.
    const command = "Write-Output 'a\"b' \"c d\" 'e\\f\\' '$x' \"g`\"h\""
    const { argv, ...spawn } = ps.command(command, process.cwd())
    expect(spawn.gated).toBe(true)
    const run = await runCommand(argv, {
      ...spawn,
      timeoutMs: 60_000,
      signal: new AbortController().signal,
    })
    expect(run.exitCode).toBe(0)
    expect(run.output.split(/\r?\n/).filter(Boolean)).toEqual(['a"b', "c d", "e\\f\\", "$x", 'g"h'])
    expect(ps.label).toMatch(/PowerShell.*\(Git Bash not found\)/)
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
