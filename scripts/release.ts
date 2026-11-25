import { execFileSync } from "node:child_process"
import path from "node:path"
import { syncVersion } from "./version-sync.ts"

const root = path.resolve(import.meta.dir, "..")

function git(args: string[], inherit = false): string {
  if (inherit) {
    execFileSync("git", args, { cwd: root, stdio: "inherit" })
    return ""
  }
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
}

function runBun(args: string[]): void {
  execFileSync("bun", args, { cwd: root, stdio: "inherit" })
}

export async function runRelease(argv: string[]): Promise<void> {
  let bump: string | undefined
  let push = false
  let dryRun = false
  let skipCheck = false
  for (const arg of argv) {
    if (arg === "--push") push = true
    else if (arg === "--dry-run") dryRun = true
    else if (arg === "--skip-check") skipCheck = true
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun run release <patch|minor|major|rc|vX.Y.Z> [--push] [--dry-run] [--skip-check]")
      return
    } else if (arg.startsWith("-")) throw new Error(`Unknown release option: ${arg}`)
    else if (!bump) bump = arg
    else throw new Error(`Unexpected extra argument: ${arg}`)
  }
  if (!bump) {
    throw new Error("Usage: bun run release <patch|minor|major|rc|vX.Y.Z> [--push] [--dry-run]")
  }
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"])
  if (branch !== "main") {
    throw new Error(`Releases must be cut from main (currently on ${branch})`)
  }
  const status = git(["status", "--porcelain"])
  if (status) {
    throw new Error("Working tree is not clean. Commit or stash your changes before releasing.")
  }
  const version = await syncVersion(["bump", bump], root)
  const tag = `v${version}`
  const existingTag = git(["tag", "--list", tag])
  if (existingTag === tag) {
    git(["checkout", "--", "packages/cli/package.json", "bun.lock"])
    throw new Error(`Tag ${tag} already exists locally.`)
  }
  console.log(`Prepared release ${tag} (${version.includes("-rc.") ? "next" : "stable"} channel)`)
  if (!skipCheck) {
    runBun(["run", "architecture:check"])
    runBun(["run", "typecheck"])
    runBun(["run", "lint"])
  }
  if (dryRun) {
    git(["checkout", "--", "packages/cli/package.json", "bun.lock"])
    console.log(`Dry run succeeded for ${tag}. Working tree restored.`)
    return
  }
  git(["add", "packages/cli/package.json", "bun.lock"], true)
  git(["commit", "-m", `release: ${tag}`], true)
  git(["tag", "-a", tag, "-m", `Amira ${tag}`], true)
  if (push) {
    git(["push", "origin", "main", tag], true)
    console.log(`Pushed main and ${tag}. GitHub Release workflow will build, sign, and publish.`)
  } else {
    console.log(`Created commit and tag ${tag}. Push with: git push origin main ${tag}`)
  }
}

if (import.meta.main) await runRelease(process.argv.slice(2))
