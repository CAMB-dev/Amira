import { expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { instructionsSection, loadInstructions } from "../src/instructions.ts"
import { defaultSections, renderPrompt, setSection } from "../src/prompt.ts"

test("loads user, repo and nested instructions parent to child, with fallbacks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amira-instr-"))
  const home = path.join(root, "home")
  const repo = path.join(root, "repo")
  const sub = path.join(repo, "pkg", "deep")
  await mkdir(home, { recursive: true })
  await mkdir(path.join(repo, ".git"), { recursive: true })
  await mkdir(sub, { recursive: true })
  await writeFile(path.join(root, "AGENTS.md"), "outside the repo")
  await writeFile(path.join(home, "AGENTS.md"), "user")
  await writeFile(path.join(repo, "AGENTS.md"), "repo")
  await writeFile(path.join(repo, "CLAUDE.md"), "ignored: AGENTS.md wins")
  await writeFile(path.join(repo, "pkg", "GEMINI.md"), "pkg")
  await writeFile(path.join(sub, "CLAUDE.md"), "deep")
  const files = loadInstructions(sub, home)
  expect(files.map((f) => f.text)).toEqual(["user", "repo", "pkg", "deep"])
  const section = instructionsSection(files)
  expect(section.indexOf("\n\nrepo")).toBeGreaterThan(0)
  expect(section.indexOf("\n\nrepo")).toBeLessThan(section.indexOf("\n\ndeep"))
  expect(instructionsSection([])).toBe("")
})

test("sections keep a stable order; setSection replaces or inserts in place", () => {
  const s = defaultSections({ cwd: "/x", project: "P", date: new Date("2026-01-02") })
  expect(s.map((x) => x.name)).toEqual([
    "identity",
    "environment",
    "project",
    "skills",
    "deferred-tools",
    "role",
  ])
  const withSkills = setSection(s, "skills", "SK")
  expect(withSkills.find((x) => x.name === "skills")?.text).toBe("SK")
  expect(withSkills[0]).toBe(s[0]!)
  const inserted = setSection(
    [
      { name: "identity", text: "I" },
      { name: "role", text: "R" },
    ],
    "project",
    "P",
  )
  expect(inserted.map((x) => x.name)).toEqual(["identity", "project", "role"])
  expect(setSection(inserted, "extra", "E").at(-1)?.name).toBe("extra")
  expect(renderPrompt(inserted)).toBe("I\n\nP\n\nR")
})

test("default identity keeps the coding and verification guidance concise", () => {
  const identity = defaultSections({ cwd: "/x" }).find((section) => section.name === "identity")?.text
  expect(identity).toMatchInlineSnapshot(`
"You are Amira, a coding agent working in the user's terminal.
You help with software engineering tasks: reading and changing code, running commands, and explaining what you find.

- Use the tools to inspect the project before changing it. Prefer reading over guessing.
- Reproduce or confirm a reported problem before fixing it. If it does not reproduce or rests on a wrong assumption, say so plainly at the top of your reply.
- Keep changes focused on what was asked. Match the surrounding code's style.
- After changing code, run the relevant checks. If a check fails and you fix it, re-run what failed before finishing.
- When you run commands, prefer non-interactive forms and explain anything destructive before doing it.
- Be concise. Report changes and check results honestly, including anything not verified."
`)
})

test("default prompt identifies a linked worktree and protects its main checkout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "amira-worktree-prompt-"))
  const main = path.join(root, "main")
  const worktree = path.join(root, "worktree")
  const gitDir = path.join(main, ".git", "worktrees", "worktree")
  await mkdir(main, { recursive: true })
  await mkdir(worktree, { recursive: true })
  await mkdir(gitDir, { recursive: true })
  await writeFile(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`)
  await writeFile(path.join(gitDir, "commondir"), "../..\n")

  const environment = defaultSections({ cwd: worktree }).find(
    (section) => section.name === "environment",
  )?.text
  expect(environment).toContain("Working directory:")
  expect(environment).toContain("Git workspace: linked worktree")
  expect(environment).toContain(`Main checkout: ${main}`)
  expect(environment).toContain("off-limits for changes unless the user explicitly asks")
})
