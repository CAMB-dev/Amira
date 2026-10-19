import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// Launcher isolation happens BEFORE bun:test's standard preload or any application import.
const root = mkdtempSync(path.join(os.tmpdir(), "amira-server-offline-"))
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (/^AMIRA_|API_?KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD/i.test(key)) delete env[key]
}
for (const name of ["local", "remote", "workspace", "xdg", "cache", "runtime", "data"]) {
  mkdirSync(path.join(root, name))
}
const home = path.join(root, "remote")
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  AMIRA_HOME: path.join(home, ".amira"),
  XDG_CONFIG_HOME: path.join(root, "xdg"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  XDG_RUNTIME_DIR: path.join(root, "runtime"),
  XDG_DATA_HOME: path.join(root, "data"),
})
if (process.platform === "win32") {
  env.HOMEDRIVE = path.parse(home).root.replace(/[\\/]$/, "")
  env.HOMEPATH = home.slice(env.HOMEDRIVE.length)
}
const files = process.argv.slice(2)
const child = Bun.spawn(
  [
    process.execPath,
    "test",
    "--preload",
    path.join(import.meta.dir, "offline.ts"),
    ...(files.length
      ? files
      : [
          path.join(import.meta.dir, "runtime.test.ts"),
          path.join(import.meta.dir, "profile.test.ts"),
          path.join(import.meta.dir, "review-regressions.test.ts"),
          path.join(import.meta.dir, "transport.test.ts"),
          path.join(import.meta.dir, "status-security.test.ts"),
          path.join(import.meta.dir, "select-dto.test.ts"),
          path.join(import.meta.dir, "runtime-events.test.ts"),
          path.join(import.meta.dir, "boundary-errors.test.ts"),
          path.join(import.meta.dir, "capture.test.ts"),
          path.join(import.meta.dir, "replay.test.ts"),
          path.join(import.meta.dir, "slow-attachment.test.ts"),
          path.join(import.meta.dir, "held-input.test.ts"),
          path.join(import.meta.dir, "projection-recovery.test.ts"),
          path.join(import.meta.dir, "retained-work.test.ts"),
          path.join(import.meta.dir, "notice-recovery.test.ts"),
          path.join(import.meta.dir, "notice-switch-recovery.test.ts"),
          path.join(import.meta.dir, "reset-authority.test.ts"),
          path.join(import.meta.dir, "reset-state-property.test.ts"),
          path.join(import.meta.dir, "retry-recovery.test.ts"),
          path.join(import.meta.dir, "owner-notifications.test.ts"),
          path.join(import.meta.dir, "files.test.ts"),
          path.join(import.meta.dir, "uploads.test.ts"),
          path.join(import.meta.dir, "jobs.test.ts"),
          path.join(import.meta.dir, "conversations.test.ts"),
          path.join(import.meta.dir, "b10-runtime.test.ts"),
          path.join(import.meta.dir, "history-pages.test.ts"),
          path.join(import.meta.dir, "native-history-cut.test.ts"),
          path.join(import.meta.dir, "file-scope-runtime.test.ts"),
        ]),
  ],
  {
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  },
)
try {
  process.exitCode = await child.exited
} finally {
  child.kill()
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
