import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { stopSpawn, waitForSpawnWork } from "../../../../scripts/spawn-test.ts"

// Run with `bun packages/cli/test/remote/e2e-offline.ts [test files...]`.
// This launcher imports no application code: even the standard test-home preload
// must first see disposable homes, not the developer's real ~/.amira.
const root = mkdtempSync(path.join(os.tmpdir(), "amira-b15-offline-"))
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (
    /^(AMIRA_|ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|AZURE_|AWS_|GITHUB_|GH_|XAI_|MISTRAL_|GROQ_|DEEPSEEK_|OPENROUTER_)/i.test(
      key,
    ) ||
    /API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)
  )
    delete env[key]
}
const home = path.join(root, "remote-home")
for (const name of ["local-home", "remote-home", "workspace", "config", "cache", "data", "state", "runtime"])
  mkdirSync(path.join(root, name))
Object.assign(env, {
  BUN_OPTIONS: "--no-env-file --no-install",
  HOME: home,
  USERPROFILE: home,
  AMIRA_HOME: path.join(home, ".amira"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_STATE_HOME: path.join(root, "state"),
  XDG_RUNTIME_DIR: path.join(root, "runtime"),
})
if (process.platform === "win32") {
  env.HOMEDRIVE = path.parse(home).root.replace(/[\\/]$/, "")
  env.HOMEPATH = home.slice(env.HOMEDRIVE.length)
}
const files = process.argv.slice(2)
let child: Bun.Subprocess | undefined
try {
  // The only child executable is this installed Bun. No SSH/platform discovery,
  // provider access, GUI, package install or cross-target runtime download.
  child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--no-install",
      "test",
      "--timeout",
      "120000",
      "--preload",
      path.join(import.meta.dir, "../server/offline.ts"),
      ...(files.length ? files : [path.join(import.meta.dir, "e2e.test.ts")]),
    ],
    { env, stdin: "ignore", stdout: "inherit", stderr: "inherit", windowsHide: true },
  )
  process.exitCode = await waitForSpawnWork("B15 isolated offline tests", child.exited, 540_000)
} finally {
  try {
    if (child) await stopSpawn(child, "B15 isolated test runner")
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
