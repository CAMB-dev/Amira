import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { BUILTIN_ROLES, loadRoles, parseRole, roleModel } from "../src/roles.ts"

const tmp = mkdtempSync(path.join(os.tmpdir(), "amira-roles-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

let n = 0
function layout() {
  const base = path.join(tmp, `case${n++}`)
  const dirs = { home: path.join(base, "home"), cwd: path.join(base, "project") }
  mkdirSync(path.join(dirs.home, "agents"), { recursive: true })
  mkdirSync(path.join(dirs.cwd, ".amira", "agents"), { recursive: true })
  return dirs
}

test("built-in roles: explorer and reviewer are read-only, coder gets every tool", () => {
  const { roles } = loadRoles({ home: path.join(tmp, "none"), cwd: path.join(tmp, "none") })
  expect([...roles.keys()]).toEqual(["explorer", "coder", "reviewer"])
  for (const name of ["explorer", "reviewer"]) {
    expect(roles.get(name)?.tools).toEqual(["read", "grep", "glob", "bash", "powershell"])
    expect(roles.get(name)?.prompt).toContain("Do not change anything")
  }
  expect(roles.get("coder")?.tools).toBeUndefined()
  expect(BUILTIN_ROLES.every((r) => r.model === undefined)).toBe(true)
})

test("parses frontmatter fields; the file name is the default name; tools may be a string", () => {
  const role = parseRole(
    "---\ndescription: Writes docs\nmodel: cheap/small\ntools: read, write\nisolation: worktree\n---\nYou write docs.\n",
    "/x/docs.md",
  )
  expect(role).toEqual({
    name: "docs",
    description: "Writes docs",
    model: "cheap/small",
    tools: ["read", "write"],
    isolation: "worktree",
    prompt: "You write docs.",
    source: "/x/docs.md",
  })
  expect(parseRole("---\nname: a\ntools: [read, grep]\n---\nbody", "/x/b.md").tools).toEqual(["read", "grep"])
  expect(() => parseRole("---\nisolation: sometimes\n---\n", "/x/c.md")).toThrow('"isolation"')
  expect(() => parseRole("---\nmodel: nomodel\n---\n", "/x/c.md")).toThrow('"model"')
  expect(() => parseRole("---\nname: bad name\n---\n", "/x/c.md")).toThrow("role name")
})

test("project roles win over user roles, which win over built-in ones; bad files are reported", () => {
  const dirs = layout()
  writeFileSync(path.join(dirs.home, "agents", "coder.md"), "---\ndescription: user coder\n---\nuser")
  writeFileSync(path.join(dirs.home, "agents", "helper.md"), "---\ndescription: user helper\n---\nuser")
  writeFileSync(
    path.join(dirs.cwd, ".amira", "agents", "helper.md"),
    "---\ndescription: project helper\n---\np",
  )
  writeFileSync(path.join(dirs.cwd, ".amira", "agents", "broken.md"), "---\nname: [oops\n---\n")
  writeFileSync(path.join(dirs.cwd, ".amira", "agents", "notes.txt"), "ignored")
  const { roles, problems } = loadRoles(dirs)
  expect(roles.get("coder")?.description).toBe("user coder")
  expect(roles.get("helper")?.description).toBe("project helper")
  expect(roles.get("explorer")?.source).toBe("built-in")
  expect(problems).toHaveLength(1)
  expect(problems[0]).toContain("broken.md")
})

test("role model: the call, then settings agents.<role>.model, then the role file, else the commander's", () => {
  const role = parseRole("---\nname: r\nmodel: file/m\n---\n", "/r.md")
  expect(roleModel(role, "call/m", { r: { model: "settings/m" } })).toBe("call/m")
  expect(roleModel(role, undefined, { r: { model: "settings/m" } })).toBe("settings/m")
  expect(roleModel(role, undefined, { other: { model: "x/y" } })).toBe("file/m")
  expect(roleModel(BUILTIN_ROLES[0], undefined, undefined)).toBeUndefined()
  expect(roleModel(undefined, undefined, { r: { model: "x/y" } })).toBeUndefined()
})
