import "../server/offline.ts"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { remoteBuiltinPresenters } from "../../src/frontend/builtin-presenters.ts"
import { loadRemoteLocalSettings } from "../../src/remote/local-settings.ts"

test("remote frontend reads only user presentation, keeps history in memory and defers credentials", () => {
  const root = mkdtempSync(path.join(tmpdir(), "amira-remote-local-"))
  const cwd = process.cwd()
  const home = path.join(root, "local")
  const project = path.join(root, "project")
  mkdirSync(home)
  mkdirSync(path.join(project, ".amira"), { recursive: true })
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ tui: { theme: "amber" } }))
  // Invalid local project configuration/auth must not even be parsed by remote UI bootstrap.
  writeFileSync(path.join(project, ".amira", "settings.json"), "not json")
  writeFileSync(path.join(home, "auth.json"), "not json")
  process.chdir(project)
  try {
    const local = loadRemoteLocalSettings(home)
    expect(local.settings?.theme).toBe("amber")
    expect(local.themes.get("amber")).toBeDefined()
    expect(local.history).toBeDefined()
    expect(local.warnings).toEqual([])
    expect(remoteBuiltinPresenters.get("bash")).toBeDefined()
    expect(remoteBuiltinPresenters.get("agent")).toBeDefined()
    expect(remoteBuiltinPresenters.get("unknown")).toBeUndefined()
  } finally {
    process.chdir(cwd)
    rmSync(root, { recursive: true, force: true })
  }
})
