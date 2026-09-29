import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { runExtCommand } from "../src/ext-command.ts"
import { ExtProgress, progressMode } from "../src/ext-progress.ts"

setDefaultTimeout(60_000)

let dir: string
let home: string
let cwd: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "amira-ext-progress-"))
  home = path.join(dir, "home")
  cwd = path.join(dir, "project")
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
})

afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))

/**
 * Replays what was written to a terminal: text, newlines, and the few sequences the progress
 * display uses (cursor to the start of an earlier line, erase line, erase to the end).
 */
class Screen {
  lines: string[] = [""]
  row = 0
  write(s: string) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal sequences
    for (const m of s.matchAll(/\x1b\[(\d*)([A-Za-z])|\n|[^\x1b\n]+/g)) {
      const t = m[0]
      if (t === "\n") {
        this.row++
        if (this.lines.length <= this.row) this.lines.push("")
      } else if (m[2] === "F") this.row = Math.max(0, this.row - Number(m[1] || 1))
      else if (m[2] === "K") this.lines[this.row] = ""
      else if (m[2] === "J") {
        // The cursor is always at the start of a line here.
        this.lines.length = this.row + 1
        this.lines[this.row] = ""
      } else if (m[2] === "m") {
        // Colors: not part of the text.
      } else if (!m[2]) this.lines[this.row] = (this.lines[this.row] ?? "") + t
    }
  }
  text(): string[] {
    return this.lines.slice(0, this.lines.at(-1) === "" ? -1 : undefined)
  }
}

function ttyProgress(columns = 80, rows = 24) {
  const screen = new Screen()
  const err: string[] = []
  const progress = new ExtProgress({
    mode: "tty",
    stdout: (s) => screen.write(s),
    stderr: (s) => {
      err.push(s)
      screen.write(s)
    },
    columns: () => columns,
    rows: () => rows,
    intervalMs: 0,
  })
  return { screen, progress, err }
}

test("in a terminal each package has a line that is redrawn in place, then a summary", () => {
  const { screen, progress } = ttyProgress()
  progress.add("alpha")
  progress.add("beta")
  progress.add("gamma")
  expect(screen.text()).toEqual(["· alpha  waiting", "· beta   waiting", "· gamma  waiting"])
  progress.update({ name: "alpha", phase: "fetching", detail: "CAMB-dev/amira-extensions", percent: 42 })
  expect(screen.text()).toEqual([
    "⠋ alpha  fetching CAMB-dev/amira-extensions 42%",
    "· beta   waiting",
    "· gamma  waiting",
  ])
  progress.update({ name: "alpha", phase: "extracting" })
  progress.finish("alpha", { kind: "updated", text: "0.1.0 → 0.1.3", line: "Updated alpha" })
  progress.update({ name: "beta", phase: "resolving", detail: "asking CAMB-dev/amira-extensions" })
  progress.finish("beta", { kind: "up to date", text: "0.2.0 @ 15a460da2aef", line: "beta is up to date" })
  progress.update({ name: "gamma", phase: "dependencies" })
  expect(screen.text()).toEqual([
    "✓ alpha  updated 0.1.0 → 0.1.3",
    "✓ beta   up to date 0.2.0 @ 15a460da2aef",
    "⠋ gamma  installing dependencies",
  ])
  progress.finish("gamma", { kind: "failed", text: "bun install failed (exit 1)", line: "amira: gamma: ..." })
  expect(progress.close()).toBe("1 updated · 1 up to date · 1 failed")
  expect(screen.text()).toEqual([
    "✓ alpha  updated 0.1.0 → 0.1.3",
    "✓ beta   up to date 0.2.0 @ 15a460da2aef",
    "✗ gamma  failed bun install failed (exit 1)",
    "1 updated · 1 up to date · 1 failed",
  ])
})

test("lines are cut to the terminal width, and more packages than fit collapse", () => {
  const { screen, progress } = ttyProgress(30, 6)
  for (const n of ["a", "b", "c", "d", "e", "f", "g"]) progress.add(n)
  progress.update({
    name: "a",
    phase: "fetching",
    detail: "some-owner/a-very-long-repository-name",
    percent: 7,
  })
  const lines = screen.text()
  expect(lines[0]).toBe("⠋ a     fetching some-owner/…")
  for (const l of lines) expect(l.length).toBeLessThanOrEqual(29)
  // 6 rows: 4 lines of the display, the last saying how many more wait.
  expect(lines).toEqual([
    "⠋ a     fetching some-owner/…",
    "· b     waiting",
    "· c     waiting",
    "… 4 more waiting",
  ])
})

test("a warning is printed above the package lines, which are drawn again below it", () => {
  const { screen, progress, err } = ttyProgress()
  progress.add("alpha")
  progress.update({ name: "alpha", phase: "resolving" })
  progress.note("amira: warning: could not refresh the extensions index")
  expect(err).toEqual(["amira: warning: could not refresh the extensions index\n"])
  expect(screen.text()).toEqual([
    "amira: warning: could not refresh the extensions index",
    "⠋ alpha  resolving",
  ])
})

test("without a terminal: one line per phase on stderr, results and the summary on stdout", () => {
  const out: string[] = []
  const err: string[] = []
  const progress = new ExtProgress({ mode: "plain", stdout: (s) => out.push(s), stderr: (s) => err.push(s) })
  progress.add("alpha")
  progress.update({ name: "alpha", phase: "fetching", detail: "o/r", percent: 10 })
  progress.update({ name: "alpha", phase: "fetching", detail: "o/r", percent: 90 })
  progress.update({ name: "alpha", phase: "extracting" })
  progress.finish("alpha", { kind: "updated", text: "", line: "Updated alpha: 1 -> 2" })
  progress.finish("beta", { kind: "failed", text: "", line: "amira: beta: update failed" })
  progress.close()
  expect(err.join("")).toBe(
    "amira: alpha: fetching o/r\namira: alpha: extracting\namira: beta: update failed\n",
  )
  expect(out.join("")).toBe("Updated alpha: 1 -> 2\n1 updated · 1 failed\n")
})

test("the mode follows --json, --quiet, the terminal and NO_COLOR", () => {
  expect(progressMode({}, true, {})).toBe("tty")
  expect(progressMode({}, false, {})).toBe("plain")
  expect(progressMode({}, true, { NO_COLOR: "1" })).toBe("plain")
  expect(progressMode({}, true, { TERM: "dumb" })).toBe("plain")
  expect(progressMode({ quiet: true }, true, {})).toBe("quiet")
  expect(progressMode({ json: true, quiet: true }, true, {})).toBe("json")
})

function capture() {
  const c = {
    out: "",
    err: "",
    stdout: (s: string) => {
      c.out += s
    },
    stderr: (s: string) => {
      c.err += s
    },
  }
  return c
}

function makePackage(name: string, version: string) {
  const at = path.join(dir, "sources", name)
  mkdirSync(at, { recursive: true })
  writeFileSync(path.join(at, "package.json"), JSON.stringify({ name, version, type: "module", amira: {} }))
  writeFileSync(path.join(at, "index.ts"), "export default () => {}\n")
  return at
}

test("ext update --json and --quiet", async () => {
  await runExtCommand(["install", "--quiet", makePackage("one", "1.0.0")], capture(), { home, cwd })
  makePackage("one", "1.1.0")
  const json = capture()
  expect(await runExtCommand(["update", "--json"], json, { home, cwd })).toBe(0)
  const events = json.out
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
  expect(events.filter((e) => e.type === "progress").map((e) => e.phase)).toEqual(["verifying", "copying"])
  expect(events.filter((e) => e.type !== "progress")).toEqual([
    { type: "result", name: "one", status: "updated", from: "1.0.0", to: "1.1.0", pinned: {} },
    { type: "summary", installed: 0, updated: 1, up_to_date: 0, removed: 0, failed: 0, cancelled: 0 },
  ])
  const quiet = capture()
  expect(await runExtCommand(["update", "-q"], quiet, { home, cwd })).toBe(0)
  expect(quiet).toMatchObject({ out: "one is up to date (1.1.0 (local copy))\n", err: "" })
})

test("ext install in a terminal draws the package line and the summary", async () => {
  const screen = new Screen()
  const io = { stdout: (s: string) => screen.write(s), stderr: (s: string) => screen.write(s) }
  const src = makePackage("drawn", "2.0.0")
  expect(await runExtCommand(["install", src], io, { home, cwd, tty: true, spinnerMs: 0 })).toBe(0)
  expect(screen.text()).toEqual(["✓ drawn  installed 2.0.0 (local copy)", "1 installed"])
  // NO_COLOR: plain lines even on a terminal.
  const plain = capture()
  await runExtCommand(["install", src], plain, { home, cwd, tty: true, env: { NO_COLOR: "1" } })
  expect(plain.out).toBe(
    "Installed drawn 2.0.0 (local copy) into user scope (was 2.0.0 (local copy))\n1 installed\n",
  )
})

async function gitRepoWithPackage(name: string): Promise<string> {
  const repo = makePackage(name, "1.0.0")
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "-A"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "one"],
  ]) {
    const p = Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" })
    expect(await p.exited).toBe(0)
  }
  return pathToFileURL(repo).href
}

test("Ctrl+C stops the package being fetched and the ones after it", async () => {
  const url = await gitRepoWithPackage("slow")
  const ac = new AbortController()
  const io = capture()
  const stderr = io.stderr
  io.stderr = (s: string) => {
    stderr(s)
    if (s.includes(": fetching")) ac.abort()
  }
  const code = await runExtCommand(["install", url, makePackage("never", "1.0.0")], io, {
    home,
    cwd,
    signal: ac.signal,
  })
  expect(code).toBe(130)
  expect(io.err).toContain("amira: stopped\n")
  expect(io.err).not.toContain("never:")
  expect(io.err).toContain(`amira: ${url}: cancelled\n`)
  expect(io.out).toBe("1 cancelled\n")
  expect(existsSync(path.join(home, "packages", "never"))).toBe(false)
  const scope = path.join(home, "packages")
  expect(existsSync(scope) ? readdirSync(scope).filter((n) => n.startsWith(".work-")) : []).toEqual([])
})

test("ext cache lists, prunes and cleans the cached repositories", async () => {
  const url = await gitRepoWithPackage("cached")
  await runExtCommand(["install", "-q", url], capture(), { home, cwd })
  const list = capture()
  await runExtCommand(["cache"], list, { home, cwd })
  expect(list.out).toMatch(
    new RegExp(`^${escapeRegExp(url)}  [\\d.]+ (B|KiB|MiB)  last used \\d{4}-\\d\\d-\\d\\d\\n1 cached, `),
  )
  // In use: prune keeps it.
  const prune = capture()
  await runExtCommand(["gc"], prune, { home, cwd })
  expect(prune.out).toBe("Nothing to remove.\n")
  await runExtCommand(["remove", "-q", "cached"], capture(), { home, cwd })
  const unused = capture()
  await runExtCommand(["cache", "list"], unused, { home, cwd })
  expect(unused.out).toContain("[unused]")
  const pruned = capture()
  await runExtCommand(["cache", "prune"], pruned, { home, cwd })
  expect(pruned.out).toMatch(/^Removed 1 cached repository \(/)
  // clean removes every one, used or not.
  await runExtCommand(["install", "-q", url], capture(), { home, cwd })
  const clean = capture()
  await runExtCommand(["cache", "clean"], clean, { home, cwd })
  expect(clean.out).toMatch(/^Removed 1 cached repository/)
  expect(await runExtCommand(["cache"], capture(), { home, cwd })).toBe(0)
})

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
