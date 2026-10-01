import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { CommandRule, PermissionMode, ShellKind } from "@amira/api"
import { validateSettings } from "../src/config/schema.ts"
import { type PermissionRule, Permissions, ruleMatches, stricterMode } from "../src/permissions/policy.ts"
import { hooksPathsIn, protectedPath, writtenPaths } from "../src/permissions/protected.ts"
import { resolvePermissions } from "../src/permissions/settings.ts"
import { commandName, parseBash, parsePowerShell } from "../src/permissions/shell-parse.ts"

const user = (command: string[], decision: CommandRule["decision"]): PermissionRule => ({
  command,
  decision,
  source: { scope: "user", file: "user.json" },
})

const bash = { name: "bash", shellKind: (): ShellKind => "bash" }
const pwsh = { name: "powershell", shellKind: (): ShellKind => "powershell" }
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "amira-perm-"))

async function decide(
  command: string,
  opts: { mode?: PermissionMode; rules?: PermissionRule[]; tool?: typeof bash } = {},
) {
  const p = new Permissions({ mode: opts.mode ?? "auto", rules: opts.rules ?? [] })
  return p.check(opts.tool ?? bash, { command }, process.cwd())
}

describe("bash reading", () => {
  test("splits simple compound commands and removes quoting", () => {
    expect(parseBash(`git status && git "push" origin || echo 'a b'; ls | wc -l`)).toEqual({
      commands: [["git", "status"], ["git", "push", "origin"], ["echo", "a b"], ["ls"], ["wc", "-l"]],
    })
    expect(parseBash("g\\it pu\\sh").commands).toEqual([["git", "push"]])
    expect(parseBash('git "pu"sh').commands).toEqual([["git", "push"]])
    expect(parseBash("git status\ngit push").commands).toEqual([
      ["git", "status"],
      ["git", "push"],
    ])
    expect(parseBash("ls # git push").commands).toEqual([["ls"]])
    expect(parseBash("npm test 2>&1 >/dev/null").complex).toBeUndefined()
    expect(parseBash("sleep 1 & git push").commands).toEqual([
      ["sleep", "1"],
      ["git", "push"],
    ])
  })

  test("anything it cannot read word by word is complex", () => {
    const complex = (s: string) => parseBash(s).complex
    expect(complex("echo $(git push)")).toContain("substitution")
    expect(complex("echo `git push`")).toContain("substitution")
    expect(complex('echo "$HOME"')).toContain("expansion")
    expect(complex("echo $HOME")).toContain("expansion")
    expect(complex("echo hi > out.txt")).toContain("redirection")
    expect(complex("cat <<EOF\nx\nEOF")).toContain("here-document")
    expect(complex("cat <<< hi")).toContain("here-string")
    expect(complex("eval git push")).toContain("runs other commands")
    expect(complex("bash -c 'git push'")).toContain("runs other commands")
    expect(complex("sudo git push")).toContain("runs other commands")
    expect(complex("FOO=1 git push")).toContain("assignment")
    expect(complex("(git push)")).toContain("subshell")
    expect(complex("{ git push; }")).toContain("braces")
    expect(complex("if true; then git push; fi")).toContain("keyword")
    expect(complex("./deploy.sh")).toContain("script")
    expect(complex("python -c 'print(1)'")).toContain("runs other commands")
    expect(complex("diff <(ls a) <(ls b)")).toContain("process substitution")
    expect(complex("echo 'unterminated")).toContain("unterminated")
    expect(complex("gi* push")).toContain("pattern")
  })

  test("the words around a substitution are still found", () => {
    expect(parseBash("echo $(git push)").commands).toContainEqual(["git", "push"])
  })
})

describe("PowerShell reading", () => {
  test("splits at ; | && || and reads its own quoting", () => {
    expect(parsePowerShell(`git status; git 'pu''sh' "x""y" | Out-Host && git log`)).toEqual({
      commands: [["git", "status"], ["git", "pu'sh", 'x"y'], ["Out-Host"], ["git", "log"]],
    })
    // The backtick escapes; a backslash is an ordinary character.
    expect(parsePowerShell("git pu`sh C:\\repo").commands).toEqual([["git", "push", "C:\\repo"]])
    expect(parsePowerShell("git ‘push’ –f").commands).toEqual([["git", "push", "-f"]])
    expect(parsePowerShell("npm test 2>&1").complex).toBeUndefined()
    expect(parsePowerShell("npm test 2>$null").complex).toBeUndefined()
  })

  test("variables, subexpressions, script blocks, the call operator and redirections are complex", () => {
    const complex = (s: string) => parsePowerShell(s).complex
    expect(complex("git push $remote")).toContain("variable")
    expect(complex("echo $(git push)")).toContain("subexpression")
    expect(complex('echo "$env:PATH"')).toContain("expansion")
    expect(complex("& git push")).toContain("call operator")
    expect(complex("1..3 | % { git push }")).toContain("script block")
    expect(complex("Invoke-Expression 'git push'")).toContain("runs other commands")
    expect(complex("iex 'git push'")).toContain("runs other commands")
    expect(complex("echo hi > out.txt")).toContain("redirection")
    expect(complex("@'\ngit push\n'@")).toContain("here-string")
    expect(complex("git --% push")).toContain("stop-parsing")
    expect(complex(".\\deploy.ps1")).toContain("script")
    expect(complex("[IO.File]::WriteAllText('a','b')")).toContain("type")
  })

  test("bash and PowerShell read the same text differently", () => {
    // A backslash escapes in bash, not in PowerShell; a backtick escapes in PowerShell only.
    expect(parseBash("git pu\\sh").commands).toEqual([["git", "push"]])
    expect(parsePowerShell("git pu\\sh").commands).toEqual([["git", "pu\\sh"]])
    expect(parsePowerShell("git pu`sh").commands).toEqual([["git", "push"]])
    expect(parseBash("git pu`sh").complex).toContain("substitution")
    // '' is an escaped quote in PowerShell, two adjacent empty strings in bash.
    expect(parseBash("echo 'a''b'").commands).toEqual([["echo", "ab"]])
    expect(parsePowerShell("echo 'a''b'").commands).toEqual([["echo", "a'b"]])
  })
})

describe("rules", () => {
  test("match the words of a command, not its text", () => {
    expect(ruleMatches({ command: ["git", "push"], decision: "ask" }, ["git", "push", "origin"])).toBe(true)
    expect(ruleMatches({ command: ["git", "push"], decision: "ask" }, ["git", "pushx"])).toBe(false)
    expect(ruleMatches({ command: ["git", "push"], decision: "ask" }, ["gitpush"])).toBe(false)
    expect(ruleMatches({ command: ["git"], decision: "deny" }, ["/usr/bin/git", "log"])).toBe(true)
    expect(ruleMatches({ command: ["git"], decision: "deny" }, ["C:\\Git\\cmd\\GIT.EXE"])).toBe(true)
    expect(commandName("C:\\x\\Npm.CMD")).toBe("npm")
  })

  test("ask and deny also match with words in between; allow only from the start", () => {
    const argv = ["git", "-C", "repo", "push"]
    expect(ruleMatches({ command: ["git", "push"], decision: "deny" }, argv)).toBe(true)
    expect(ruleMatches({ command: ["git", "push"], decision: "ask" }, ["git", "PUSH"])).toBe(true)
    expect(ruleMatches({ command: ["git", "push"], decision: "allow" }, argv)).toBe(false)
    expect(ruleMatches({ command: ["git", "push"], decision: "allow" }, ["git", "PUSH"])).toBe(false)
    expect(ruleMatches({ command: ["git", "status"], decision: "allow" }, ["git", "status", "-s"])).toBe(true)
  })

  test("deny beats ask beats allow, and every part of a compound command is checked", async () => {
    const rules = [user(["git"], "allow"), user(["git", "push"], "ask"), user(["rm"], "deny")]
    expect((await decide("git status", { mode: "edits", rules })).decision).toBe("allow")
    expect((await decide("git push", { mode: "edits", rules })).decision).toBe("ask")
    expect((await decide("git status && rm -rf x", { mode: "edits", rules })).decision).toBe("deny")
    expect((await decide("git status; git push", { rules })).decision).toBe("ask")
    const v = await decide("git log | rm x", { rules })
    expect(v).toMatchObject({ decision: "deny", cause: "rule", rule: { command: ["rm"] } })
    expect(v.reason).toContain('rule ["rm"] (deny, user settings user.json)')
  })

  test("allow only means do not ask: it lifts neither plan mode nor complex commands", async () => {
    const rules = [user(["git"], "allow")]
    expect((await decide("git status", { mode: "plan", rules })).decision).toBe("deny")
    expect((await decide("git log > out.txt", { mode: "edits", rules })).decision).toBe("ask")
    expect((await decide("git status && npm test", { mode: "edits", rules })).decision).toBe("ask")
  })

  test("a complex command asks when rules could be hidden in it, and is denied when a deny shows", async () => {
    const rules = [user(["git", "push"], "ask")]
    expect(await decide("echo `date`", { rules })).toMatchObject({ decision: "ask", cause: "complex" })
    expect((await decide("echo $(rm -rf /)", { rules: [user(["rm"], "deny")] })).decision).toBe("deny")
    expect((await decide("echo `rm -rf /`", { rules: [user(["rm"], "deny")] })).decision).toBe("deny")
    // In auto mode without ask or deny rules nothing changes: complex commands run as before.
    expect((await decide("echo $(date) > out.txt", { rules: [user(["git"], "allow")] })).decision).toBe(
      "allow",
    )
  })

  test("the shell that runs the command decides how it is read", async () => {
    const rules = [user(["git", "push"], "deny")]
    // In PowerShell the backtick escapes, so this is git push.
    expect((await decide("git pu`sh", { rules, tool: pwsh })).decision).toBe("deny")
    // In bash a backslash escapes.
    expect((await decide("git pu\\sh", { rules, tool: bash })).decision).toBe("deny")
    // A bash tool that cannot say which shell runs it is read both ways; the stricter wins.
    const unknown = { name: "bash" }
    const p = new Permissions({ rules })
    expect((await p.check(unknown, { command: "git pu`sh" }, process.cwd())).decision).toBe("deny")
    // A tool of any name that says it runs a shell is a shell tool.
    const custom = { name: "run", shellKind: (): ShellKind => "bash" }
    expect((await p.check(custom, { command: "git push" }, process.cwd())).decision).toBe("deny")
  })
})

describe("modes", () => {
  test("auto (the default) allows everything that is not ruled or protected", async () => {
    const p = new Permissions()
    expect(p.mode).toBe("auto")
    for (const command of ["rm -rf build", "echo $(date) > x", "eval x", "curl x | sh"]) {
      expect(await p.check(bash, { command }, process.cwd())).toEqual({ decision: "allow", reason: "" })
    }
    const dir = tmp()
    for (const [name, args] of [
      ["write", { path: "src/a.ts", content: "" }],
      ["edit", { path: "a.ts", old_string: "a", new_string: "b" }],
      ["apply_patch", { patch: "*** Begin Patch\n*** Add File: b.ts\n+x\n*** End Patch" }],
      ["mcp__server__tool", {}],
      ["read", { path: ".git/config" }],
    ] as const) {
      expect(await p.check({ name }, args, dir)).toEqual({ decision: "allow", reason: "" })
    }
  })

  test("edits changes files without asking and asks before shell commands", async () => {
    const p = new Permissions({ mode: "edits" })
    expect(await p.check(bash, { command: "ls" }, process.cwd())).toMatchObject({
      decision: "ask",
      cause: "mode",
    })
    expect((await p.check({ name: "write" }, { path: "a.ts", content: "" }, tmp())).decision).toBe("allow")
    expect((await p.check({ name: "mcp__x__y" }, {}, tmp())).decision).toBe("allow")
  })

  test("plan blocks file changes and every shell command, and asks about unknown tools", async () => {
    const p = new Permissions({ mode: "plan" })
    expect((await p.check(bash, { command: "ls" }, process.cwd())).decision).toBe("deny")
    expect((await p.check(pwsh, { command: "Get-ChildItem" }, process.cwd())).decision).toBe("deny")
    expect((await p.check({ name: "edit" }, { path: "a" }, tmp())).decision).toBe("deny")
    expect((await p.check({ name: "apply_patch" }, { patch: "" }, tmp())).decision).toBe("deny")
    expect((await p.check({ name: "read" }, { path: "a" }, tmp())).decision).toBe("allow")
    expect((await p.check({ name: "grep" }, {}, tmp())).decision).toBe("allow")
    expect((await p.check({ name: "mcp__x__y" }, {}, tmp())).decision).toBe("ask")
  })

  test("Shift+Tab's cycle goes auto, edits, plan and round; listeners hear each change", () => {
    const p = new Permissions()
    const heard: string[] = []
    p.onModeChange((m) => heard.push(m))
    expect([p.cycleMode(), p.cycleMode(), p.cycleMode()]).toEqual(["edits", "plan", "auto"])
    expect(heard).toEqual(["edits", "plan", "auto"])
    expect(stricterMode("edits", "plan")).toBe("plan")
    expect(stricterMode("edits", "auto")).toBe("edits")
  })
})

describe("protected paths", () => {
  function repo() {
    const dir = tmp()
    mkdirSync(path.join(dir, ".git", "hooks"), { recursive: true })
    writeFileSync(path.join(dir, ".git", "config"), "[core]\n\thooksPath = tools/hooks\n")
    mkdirSync(path.join(dir, "src"))
    return dir
  }
  const opts = { homedir: tmp(), amiraHome: path.join(tmp(), "amira-home"), env: {} }

  test("Amira's and Git's control files are protected, under every name they go by", () => {
    const dir = repo()
    const hit = (p: string, cwd = dir) => protectedPath(cwd, p, opts)?.what
    expect(hit(".amira/settings.json")).toContain(".amira")
    expect(hit("sub/.amira/packages/x/index.ts")).toContain(".amira")
    expect(hit(path.join(opts.amiraHome, "settings.json"))).toContain(".amira")
    expect(hit(".git/hooks/pre-commit")).toContain("hooks")
    expect(hit(".git/config")).toContain("config")
    expect(hit(".git/info/attributes")).toContain(".git")
    expect(hit(".git")).toContain(".git")
    expect(hit(".gitmodules")).toContain("submodule")
    expect(hit("tools/hooks/pre-push")).toContain("core.hooksPath")
    expect(hit(path.join(opts.homedir, ".gitconfig"))).toContain("Git config")
    // ../ and absolute paths, and case.
    expect(hit("../src/../.git/hooks/x", path.join(dir, "src"))).toContain("hooks")
    expect(hit(path.join(dir, ".GIT", "Config"))).toContain("config")
    expect(hit(".Amira/Settings.json")).toContain(".amira")
    expect(hit("src/a.ts")).toBeUndefined()
    expect(hit("docs/git-hooks.md")).toBeUndefined()
  })

  test("Windows aliases: MSYS paths, trailing dots, data streams, device prefixes", () => {
    if (process.platform !== "win32") return
    const dir = repo()
    const msys = `/${dir[0]!.toLowerCase()}/${dir.slice(3).replaceAll("\\", "/")}/.git/config`
    expect(protectedPath(dir, msys, opts)).toBeDefined()
    expect(protectedPath(dir, ".git./config", opts)).toBeDefined()
    expect(protectedPath(dir, ".git\\config::$DATA", opts)).toBeDefined()
    expect(protectedPath(dir, ".amira ./settings.json", opts)).toBeDefined()
    expect(protectedPath(dir, `\\\\?\\${dir}\\.git\\hooks\\x`, opts)).toBeDefined()
  })

  test("a link into a protected directory is followed", () => {
    const dir = repo()
    try {
      symlinkSync(path.join(dir, ".git", "hooks"), path.join(dir, "innocent"), "junction")
    } catch {
      return // links need a privilege this machine does not give
    }
    expect(protectedPath(dir, "innocent/pre-commit", opts)?.what).toContain("hooks")
  })

  test("a linked worktree's Git directory, wherever it is, is protected", () => {
    const main = tmp()
    const gitDir = path.join(main, "elsewhere", "wt")
    mkdirSync(gitDir, { recursive: true })
    const wt = tmp()
    writeFileSync(path.join(wt, ".git"), `gitdir: ${gitDir}\n`)
    expect(protectedPath(wt, path.join(gitDir, "hooks", "x"), opts)).toBeDefined()
    expect(protectedPath(wt, ".git", opts)).toBeDefined()
  })

  test("write, edit and apply_patch ask before protected files, even in auto mode", async () => {
    const dir = repo()
    const p = new Permissions({ protect: opts })
    const v = await p.check({ name: "write" }, { path: ".git/hooks/pre-commit", content: "x" }, dir)
    expect(v).toMatchObject({ decision: "ask", cause: "protected" })
    expect(v.reason).toContain("Git hooks")
    const patch =
      "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: .amira/settings.json\n@@\n-a\n+b\n*** End Patch"
    expect((await p.check({ name: "apply_patch" }, { patch }, dir)).decision).toBe("ask")
    expect(writtenPaths("apply_patch", { patch })).toEqual(["src/a.ts", ".amira/settings.json"])
    expect(hooksPathsIn('[core]\n  hooksPath = "x y"\n[alias]\n  hooksPath = no')).toEqual(["x y"])
  })
})

describe("settings scopes", () => {
  const layer = (scope: "user" | "project" | "flags", permissions: object, file = `${scope}.json`) => ({
    scope,
    file,
    permissions,
  })

  test("a project can only tighten: stricter modes, ask and deny rules; allow rules once trusted", () => {
    const layers = [
      layer("user", { mode: "edits", rules: [{ command: ["git", "push"], decision: "ask" }] }),
      layer("project", {
        mode: "auto",
        rules: [
          { command: ["git", "push"], decision: "allow" },
          { command: ["rm"], decision: "deny" },
        ],
      }),
    ]
    const untrusted = resolvePermissions(layers, { trusted: false })
    expect(untrusted.mode).toBe("edits")
    expect(untrusted.rules.map((r) => [r.command.join(" "), r.decision, r.source.scope])).toEqual([
      ["git push", "ask", "user"],
      ["rm", "deny", "project"],
    ])
    expect(untrusted.warnings.join("\n")).toContain('"permissions.mode" "auto" is ignored')
    expect(untrusted.warnings.join("\n")).toContain('1 "allow" rule is ignored; this project is not trusted')
    const trusted = resolvePermissions(layers, { trusted: true })
    expect(trusted.rules).toHaveLength(3)
    expect(resolvePermissions([layer("project", { mode: "plan" })], { trusted: false }).mode).toBe("plan")
    expect(
      resolvePermissions([layer("project", { mode: "plan" }), layer("flags", { mode: "auto" })], {
        trusted: false,
      }),
    ).toMatchObject({ mode: "auto", modeSource: "flags.json" })
  })

  test("a trusted project's allow cannot override the user's ask or deny", async () => {
    const { rules } = resolvePermissions(
      [
        layer("user", { rules: [{ command: ["git", "push"], decision: "deny" }] }),
        layer("project", { rules: [{ command: ["git", "push"], decision: "allow" }] }),
      ],
      { trusted: true },
    )
    expect((await decide("git push", { mode: "edits", rules })).decision).toBe("deny")
  })

  test("the settings schema takes permissions and refuses bad rules", () => {
    const ok = validateSettings(
      {
        permissions: {
          mode: "edits",
          rules: [{ command: ["git", "push"], decision: "ask", reason: "review" }],
        },
      },
      "s.json",
    )
    expect(ok.warnings).toEqual([])
    expect(() => validateSettings({ permissions: { mode: "yolo" } }, "s.json")).toThrow('"permissions.mode"')
    expect(() =>
      validateSettings({ permissions: { rules: [{ command: "git push", decision: "ask" }] } }, "s.json"),
    ).toThrow("list of the command's words")
    expect(() =>
      validateSettings({ permissions: { rules: [{ command: ["git"], decision: "maybe" }] } }, "s.json"),
    ).toThrow('"permissions.rules[0].decision"')
  })
})
