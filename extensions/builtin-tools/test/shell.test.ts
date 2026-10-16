import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ToolRegistry } from "../../../packages/core/src/index.ts"
import { cmdArgv, runCommand } from "../../../packages/proc/src/index.ts"
import {
  SPAWN_TEST_TIMEOUT_MS,
  stopSpawn,
  waitForSpawnCondition,
  waitForSpawnExit,
} from "../../../scripts/spawn-test.ts"
import { bashTool, powershellTool } from "../src/bash.ts"
import {
  availableShellTools,
  bashFromGitExecPath,
  fallbackPowerShell,
  findGitBash,
  GATE_SCRIPT,
  gitBashEnv,
  gitBashLayout,
  isRejectedShellPath,
  resolveShell,
  shellToolNames,
} from "../src/shell.ts"
import { spawnWorkScope, waitForSpawnWork } from "./util.ts"

const work = spawnWorkScope("gate shells cleanup")
afterEach(() => work.cleanup(), SPAWN_TEST_TIMEOUT_MS)

const norm = (p: string) => p.replaceAll("\\", "/")
const fakeFs = (...files: string[]) => {
  const set = new Set(files.map(norm))
  return (p: string) => set.has(norm(p))
}

test("shell tool selection preserves POSIX and explicit modes, and deduplicates Windows auto", async () => {
  const bash = async () => ({ kind: "bash" as const })
  const fallback = async () => ({ kind: "powershell" as const })
  expect(await shellToolNames("auto", "win32", bash)).toEqual(["bash", "powershell"])
  expect(await shellToolNames("auto", "win32", fallback)).toEqual(["powershell"])
  expect(await shellToolNames("bash", "win32", fallback)).toEqual(["bash"])
  expect(await shellToolNames("powershell", "win32", bash)).toEqual(["powershell"])
  for (const platform of ["linux", "darwin"]) {
    expect(await shellToolNames("auto", platform, fallback)).toEqual(["bash"])
    expect(await shellToolNames("bash", platform, fallback)).toEqual(["bash"])
  }
})

test("Windows auto hides the bash fallback but explicit bash and switching still work", async () => {
  let mode: "auto" | "bash" | "powershell" = "auto"
  const tools = await availableShellTools(
    [bashTool, powershellTool],
    () => mode,
    "win32",
    async () => ({ kind: "powershell" }),
  )
  const registry = new ToolRegistry()
  for (const tool of tools) registry.register(tool, "test")
  const names = () => registry.specs().map((tool) => tool.name)
  expect(names()).toEqual(["powershell"])
  expect(registry.has("bash")).toBe(true)
  mode = "bash"
  registry.setDisabled(["powershell"])
  expect(names()).toEqual(["bash"])
  mode = "powershell"
  registry.setDisabled(["bash"])
  expect(names()).toEqual(["powershell"])
  mode = "auto"
  registry.setDisabled([])
  expect(names()).toEqual(["powershell"])
})

test("rejects WSL and Store aliases", () => {
  expect(isRejectedShellPath("C:\\Windows\\System32\\bash.exe")).toBe(true)
  expect(isRejectedShellPath("C:/Users/me/AppData/Local/Microsoft/WindowsApps/bash.exe")).toBe(true)
  expect(isRejectedShellPath("D:\\DevSDKs\\Git\\bin\\bash.exe")).toBe(false)
})

test("enables pipefail for gated bash commands", () => {
  expect(GATE_SCRIPT).toContain('"$BASH" -o pipefail -c')
})

test("the command form used by background bash jobs enables pipefail", () => {
  const command = shell.command("false | tail -n 1", process.cwd())
  if (command.gated) expect(GATE_SCRIPT).toContain('"$BASH" -o pipefail -c')
  else expect(command.argv).toEqual(expect.arrayContaining(["-o", "pipefail"]))
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
  let proc: Bun.Subprocess<"pipe", "pipe", "ignore"> | undefined
  let reading: Promise<void> | undefined
  try {
    const marker = join(dir, "ran").replaceAll("\\", "/")
    const { argv, env } = shell.command(`echo > "${marker}"; exit 4`, dir)
    const wrapped = throughCmd ? cmdArgv(argv, { cwd: dir, env, gated: true }) : argv
    expect(wrapped).toBeDefined()
    // Observe the shell that owns the gate, not time spent waiting for Windows startup.
    if (throughCmd) wrapped![wrapped!.length - 1] = wrapped!.at(-1)!.replace(/^"/, '"echo gate-ready&')
    else wrapped![2] = `echo gate-ready; ${wrapped![2]}`
    proc = work.own(
      Bun.spawn(wrapped!, {
        cwd: dir,
        env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        windowsVerbatimArguments: throughCmd,
      }),
    )
    let output = ""
    const stdout = proc.stdout
    reading = (async () => {
      for await (const chunk of stdout) output += new TextDecoder().decode(chunk)
    })()
    await waitForSpawnCondition("gate shell startup", () => output.includes("gate-ready"))
    await Bun.sleep(1500)
    expect(existsSync(marker)).toBe(false)
    if (line !== undefined) proc.stdin.write(`${line}\n`)
    await proc.stdin.end()
    expect(await waitForSpawnExit(proc, "gate shell")).toBe(expectRan ? 4 : 125)
    expect(existsSync(marker)).toBe(expectRan)
  } finally {
    try {
      if (proc) await stopSpawn(proc, "gate shell cleanup")
      if (reading) await waitForSpawnWork("gate stdout cleanup", reading)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}

test.if(gated)(
  "a gated command runs only after a line arrives on stdin",
  () => checkGate(false, "", true),
  SPAWN_TEST_TIMEOUT_MS,
)

// Direct MSYS startup can block for seconds on Windows, in addition to the gate
// observation interval. Give EOF the same real-process budget as the other gate cases.
test.if(gated)(
  "a gated command does not run when stdin closes without a line",
  () => checkGate(false, undefined, false),
  SPAWN_TEST_TIMEOUT_MS,
)

test.if(gated)(
  "through cmd, the gate is held by cmd",
  () => checkGate(true, "go", true),
  SPAWN_TEST_TIMEOUT_MS,
)

test.if(gated)(
  "through cmd, an empty or missing gate line runs nothing",
  async () => {
    await checkGate(true, "", false)
    await checkGate(true, undefined, false)
  },
  SPAWN_TEST_TIMEOUT_MS,
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
  SPAWN_TEST_TIMEOUT_MS,
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
