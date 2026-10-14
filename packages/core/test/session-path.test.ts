import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { takeFilesystemGate } from "../src/file-lock-gate.ts"
import { canonicalSessionFile } from "../src/session-path.ts"
import { sessionLockFile } from "../src/session-store.ts"

interface Alias {
  file: string
  target: string
  type: "file" | "dir"
  physical?: string
  names?: string[]
}

/** Exercise the same resolver even when Windows denies file/directory symlink creation. */
function withAliases(aliases: Alias[], mocked: boolean, run: () => void) {
  if (!mocked) {
    try {
      for (const alias of aliases) fs.symlinkSync(alias.target, alias.file, alias.type)
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
      )
        throw error
      mocked = true
    }
  }
  if (!mocked) return run()
  const symbolic = Object.assign(Object.create(fs.statSync(path.dirname(aliases[0]!.file))), {
    isSymbolicLink: () => true,
  })
  const lstat = fs.lstatSync
  const realpath = fs.realpathSync
  const readlink = fs.readlinkSync
  const match = (file: unknown) =>
    aliases.find(
      (alias) =>
        String(file) === alias.file ||
        alias.names?.includes(String(file)) ||
        (alias.type === "dir" && String(file).startsWith(`${alias.file}${path.sep}`)),
    )
  const translated = (alias: Alias, file: unknown) => {
    if (!alias.physical) throw Object.assign(new Error("dangling alias"), { code: "ENOENT" })
    return alias.type === "file"
      ? alias.physical
      : `${alias.physical}${String(file).slice(alias.file.length)}`
  }
  const stating = spyOn(fs, "lstatSync").mockImplementation(
    new Proxy(lstat, {
      apply(target, receiver, args) {
        const alias = match(args[0])
        if (alias && (alias.type === "file" || String(args[0]) === alias.file)) return symbolic
        return Reflect.apply(target, receiver, alias ? [translated(alias, args[0]), ...args.slice(1)] : args)
      },
    }),
  )
  const resolving = spyOn(fs, "realpathSync").mockImplementation(
    new Proxy(realpath, {
      apply(target, receiver, args) {
        const alias = match(args[0])
        return Reflect.apply(target, receiver, alias ? [translated(alias, args[0]), ...args.slice(1)] : args)
      },
    }),
  )
  const reading = spyOn(fs, "readlinkSync").mockImplementation(
    new Proxy(readlink, {
      apply(target, receiver, args) {
        const alias = match(args[0])
        return alias && (alias.type === "file" || String(args[0]) === alias.file)
          ? alias.target
          : Reflect.apply(target, receiver, args)
      },
    }),
  )
  try {
    run()
  } finally {
    stating.mockRestore()
    resolving.mockRestore()
    reading.mockRestore()
  }
}

test("an unpublished session resolves its parent without probing the missing file with realpath", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "amira-session-path-"))
  const parent = fs.realpathSync(dir)
  const realpath = spyOn(fs, "realpathSync")
  const lstat = spyOn(fs, "lstatSync")
  const stat = spyOn(fs, "statSync")
  const file = path.join(dir, "new.jsonl")
  try {
    expect(canonicalSessionFile(file)).toBe(path.join(parent, "new.jsonl"))
    expect(realpath.mock.calls.some(([target]) => target === dir)).toBe(true)
    expect(realpath.mock.calls.some(([target]) => target === file)).toBe(false)
    expect(lstat.mock.calls.filter(([target]) => target === file)).toHaveLength(1)
    expect(lstat.mock.calls.some(([target]) => target === dir)).toBe(false)
    expect(stat).not.toHaveBeenCalled()
    expect(fs.readdirSync(dir)).toEqual([])
  } finally {
    realpath.mockRestore()
    lstat.mockRestore()
    stat.mockRestore()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

for (const mocked of [false, true]) {
  for (const published of [false, true]) {
    test(`a relative ${published ? "existing" : "unpublished"} link under a directory alias retains legacy naming (${mocked ? "mocked" : "filesystem"})`, () => {
      const dir = fs.mkdtempSync(path.join(tmpdir(), "amira-session-link-"))
      const physical = path.join(dir, "physical")
      const child = path.join(physical, "child")
      const logical = path.join(dir, "logical")
      try {
        fs.mkdirSync(child, { recursive: true })
        fs.mkdirSync(logical)
        if (published) fs.writeFileSync(path.join(physical, "session.jsonl"), "session")
        // A Windows junction needs no symlink privilege.
        fs.symlinkSync(child, path.join(logical, "alias"), process.platform === "win32" ? "junction" : "dir")
        const link = path.join(child, "link.jsonl")
        withAliases(
          [
            {
              file: link,
              names: [path.join(logical, "alias", "link.jsonl")],
              target: "../session.jsonl",
              type: "file",
              physical: path.join(physical, "session.jsonl"),
            },
          ],
          mocked,
          () => {
            expect(canonicalSessionFile(path.join(logical, "alias", "link.jsonl"))).toBe(
              path.join(fs.realpathSync(published ? physical : logical), "session.jsonl"),
            )
          },
        )
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  test(`symlink targets containing hop/.. use realpath once published (${mocked ? "mocked" : "filesystem"})`, () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "amira-session-hop-"))
    const p = path.join(dir, "p")
    const q = path.join(dir, "q")
    try {
      fs.mkdirSync(p)
      fs.mkdirSync(path.join(q, "child"), { recursive: true })
      fs.symlinkSync(
        path.join(q, "child"),
        path.join(p, "hop"),
        process.platform === "win32" ? "junction" : "dir",
      )
      const link = path.join(p, "link.jsonl")
      const target = path.join(q, "session.jsonl")
      withAliases(
        [{ file: link, target: "hop/../session.jsonl", type: "file", physical: target }],
        mocked,
        () => {
          // Keep the previous release's lexical namespace for a missing target.
          expect(canonicalSessionFile(link)).toBe(path.join(fs.realpathSync(p), "session.jsonl"))
          fs.writeFileSync(path.join(p, "session.jsonl"), "wrong file")
          fs.writeFileSync(target, "requested file")
          expect(canonicalSessionFile(link)).toBe(fs.realpathSync(link))
          if (mocked || process.platform !== "win32")
            expect(canonicalSessionFile(link)).toBe(fs.realpathSync(target))
        },
      )
      const traversal = `${p}${path.sep}hop${path.sep}..${path.sep}session.jsonl`
      expect(canonicalSessionFile(traversal)).toBe(fs.realpathSync(traversal))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test(`session aliases retain cycle detection (${mocked ? "mocked" : "filesystem"})`, () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "amira-session-cycle-"))
    const a = path.join(dir, "a.jsonl")
    const b = path.join(dir, "b.jsonl")
    try {
      withAliases(
        [
          { file: a, target: "b.jsonl", type: "file" },
          { file: b, target: "a.jsonl", type: "file" },
        ],
        mocked,
        () => {
          expect(() => canonicalSessionFile(a)).toThrow(/cyclic|symbolic links|ELOOP/i)
        },
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("unpublished parent directories resolve from their existing physical ancestor", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "amira-session-path-"))
  try {
    const file = path.join(dir, "nested", "sessions", "new.jsonl")
    expect(canonicalSessionFile(file)).toBe(
      path.join(fs.realpathSync(dir), "nested", "sessions", "new.jsonl"),
    )
    expect(fs.readdirSync(dir)).toEqual([])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("hard-linked session files are refused without needing symlink privileges", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "amira-session-hard-link-"))
  try {
    const file = path.join(dir, "session.jsonl")
    fs.writeFileSync(file, "session")
    fs.linkSync(file, path.join(dir, "hard.jsonl"))
    expect(() => canonicalSessionFile(file)).toThrow(/hard.link/i)
    expect(() => canonicalSessionFile(path.join(dir, "hard.jsonl"))).toThrow(/hard.link/i)
    withAliases(
      [{ file: path.join(dir, "symbolic.jsonl"), target: file, physical: file, type: "file" }],
      true,
      () => expect(() => canonicalSessionFile(path.join(dir, "symbolic.jsonl"))).toThrow(/hard.link/i),
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test("a hard link introduced after the initial path probe is still refused", () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "amira-session-hard-link-"))
  const file = path.join(dir, "session.jsonl")
  fs.writeFileSync(file, "session")
  const realpath = fs.realpathSync
  const resolving = spyOn(fs, "realpathSync").mockImplementation(
    new Proxy(realpath, {
      apply(target, receiver, args) {
        if (args[0] === file) fs.linkSync(file, path.join(dir, "hard.jsonl"))
        return Reflect.apply(target, receiver, args)
      },
    }),
  )
  try {
    expect(() => canonicalSessionFile(file)).toThrow(/hard.link/i)
  } finally {
    resolving.mockRestore()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

for (const kind of ["junction", "symlink", "mocked-symlink", "case", "relative"] as const) {
  test(`${kind} directory aliases retain the previous release's session and gate namespace`, () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "amira-session-namespace-"))
    const physical = path.join(dir, "MixedCase")
    fs.mkdirSync(physical)
    let unlock: (() => void) | undefined
    const staging = spyOn(fs, "mkdtempSync")
    try {
      let alias = physical
      if (kind === "junction") {
        alias = path.join(dir, "alias")
        fs.symlinkSync(physical, alias, process.platform === "win32" ? "junction" : "dir")
      } else if (kind === "symlink" || kind === "mocked-symlink") alias = path.join(dir, "alias")
      else if (kind === "case" && process.platform === "win32") alias = physical.toLowerCase()
      else if (kind === "relative") alias = path.relative(process.cwd(), physical)
      const check = () => {
        const file = path.join(alias, "session.jsonl")
        const legacyLock = path.join(fs.realpathSync(path.resolve(alias)), "session.jsonl.lock")
        expect(sessionLockFile(file)).toBe(legacyLock)
        unlock = takeFilesystemGate(legacyLock)
        expect(unlock).toBeDefined()
        expect(staging).toHaveBeenCalledWith(`${legacyLock}.lease-gate.pending-${process.pid}-`)
        expect(fs.existsSync(`${legacyLock}.lease-gate`)).toBe(true)
        expect(takeFilesystemGate(path.join(physical, "session.jsonl.lock"))).toBeUndefined()
      }
      if (kind === "symlink" || kind === "mocked-symlink")
        withAliases(
          [{ file: alias, target: physical, physical, type: "dir" }],
          kind === "mocked-symlink",
          check,
        )
      else check()
    } finally {
      staging.mockRestore()
      unlock?.()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}
