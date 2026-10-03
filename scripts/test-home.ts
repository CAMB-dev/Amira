import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Do not change these to runtime ESM imports. Bun snapshots named fs exports on first
// import; patching require() first also protects subsequent named imports, without mocks.
const fs: typeof import("node:fs") = require("node:fs")
const promises: typeof import("node:fs/promises") = require("node:fs/promises")
const realpath = fs.realpathSync

function filename(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (value instanceof URL) return fileURLToPath(value)
  if (Buffer.isBuffer(value)) return value.toString()
  return undefined
}

function normalized(value: string): string {
  const absolute = path.resolve(value)
  return process.platform === "win32" ? absolute.toLowerCase() : absolute
}

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  )
}

// Resolve the existing parent even when the file (or several directories) is new.
// Only filesystem metadata is read: no watchers, scans, or writes to protected homes.
function canonical(value: string): string {
  // POSIX resolves each symlink before a following `..`; path.resolve() does not.
  if (process.platform !== "win32" && value.split("/").includes("..")) {
    let current = path.isAbsolute(value) ? "/" : process.cwd()
    for (const part of value.split("/")) {
      if (!part || part === ".") continue
      current = path.join(current, part)
      try {
        current = realpath(current)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error
      }
    }
    return normalized(current)
  }
  let parent = path.resolve(value)
  const suffix: string[] = []
  for (;;) {
    try {
      return normalized(path.join(realpath(parent), ...suffix))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error
      const next = path.dirname(parent)
      if (next === parent) return normalized(value)
      suffix.unshift(path.basename(parent))
      parent = next
    }
  }
}

// This is a process-local tripwire, not a sandbox. Children inherit isolated homes but
// need their own preload to guard explicit paths. Native code, pre-captured fs functions,
// pre-existing hard links and symlink races are outside its coverage.
/** Test infrastructure only. Install before importing any application filesystem users. */
function guardTestHome(roots: string[]): { violations: string[] } {
  const protectedRoots = roots.flatMap((root) => [normalized(root), canonical(root)])
  const violations: string[] = []
  const descriptors = new Map<number, string>()
  const writable = (flags: unknown) =>
    typeof flags === "number"
      ? (flags &
          (fs.constants.O_WRONLY |
            fs.constants.O_RDWR |
            fs.constants.O_CREAT |
            fs.constants.O_TRUNC |
            fs.constants.O_APPEND)) !==
        0
      : typeof flags === "string" && /[wa+]/.test(flags)

  function check(value: unknown, operation: string, ancestors = false, entry = false): void {
    const descriptor = typeof value === "object" && value !== null && "fd" in value ? value.fd : value
    const name = typeof descriptor === "number" ? descriptors.get(descriptor) : filename(value)
    if (name === undefined) return
    const lexical = normalized(name)
    const blocked = (target: string) =>
      protectedRoots.some((root) => contains(root, target) || (ancestors && contains(target, root)))
    // Removing or renaming a symlink changes its directory entry, not its target.
    const resolved = entry
      ? normalized(path.join(canonical(path.dirname(name)), path.basename(name)))
      : canonical(name)
    if (!blocked(lexical) && !blocked(resolved)) return
    const message = `Test home guard blocked ${operation}: ${name}`
    violations.push(message)
    throw new Error(message)
  }

  type Method = (...args: unknown[]) => unknown
  function wrap(target: object, name: string, handler: (original: Method, args: unknown[]) => unknown) {
    const methods = target as Record<string, unknown>
    const original = methods[name]
    if (typeof original !== "function") return
    methods[name] = function (this: unknown, ...args: unknown[]) {
      return handler((...forwarded) => original.apply(this, forwarded), args)
    }
  }

  for (const target of [fs, promises]) {
    for (const operation of [
      "writeFile",
      "appendFile",
      "mkdir",
      "mkdtemp",
      "unlink",
      "rm",
      "rmdir",
      "truncate",
      "chmod",
      "chown",
      "utimes",
      "lutimes",
      "lchmod",
      "lchown",
      "write",
      "writev",
      "ftruncate",
      "fchmod",
      "fchown",
      "futimes",
      "createWriteStream",
      "copyFile",
      "cp",
      "rename",
      "link",
      "symlink",
    ]) {
      for (const name of [operation, `${operation}Sync`]) {
        wrap(target, name, (original, args) => {
          if (
            operation === "createWriteStream" &&
            typeof args[1] === "object" &&
            args[1] !== null &&
            "fd" in args[1]
          ) {
            check(args[1].fd, name)
          }
          if (operation === "copyFile" || operation === "cp" || operation === "symlink") {
            const recursive =
              operation === "cp" &&
              typeof args[2] === "object" &&
              args[2] !== null &&
              "recursive" in args[2] &&
              args[2].recursive === true
            check(args[1], name, recursive)
          } else {
            const ancestor = operation === "rm" || operation === "rmdir" || operation === "rename"
            check(args[0], name, ancestor, ancestor || operation === "unlink")
            if (operation === "rename" || operation === "link") {
              check(args[1], name, operation === "rename", operation === "rename")
            }
          }
          return original(...args)
        })
      }
    }
    for (const name of ["open", "openSync"]) {
      wrap(target, name, (original, args) => {
        if (writable(args[1])) check(args[0], name)
        const input = filename(args[0])
        const file = input === undefined ? undefined : canonical(input)
        const remember = (fd: number) => {
          if (file !== undefined) descriptors.set(fd, file)
        }
        if (target === promises) {
          return (original(...args) as ReturnType<typeof promises.open>).then((handle) => {
            remember(handle.fd)
            wrap(handle, "close", (invoke, values) => {
              descriptors.delete(handle.fd)
              return invoke(...values)
            })
            for (const method of [
              "write",
              "writev",
              "writeFile",
              "appendFile",
              "truncate",
              "chmod",
              "chown",
              "utimes",
              "createWriteStream",
            ]) {
              wrap(handle, method, (invoke, values) => {
                check(file, `FileHandle.${method}`)
                return invoke(...values)
              })
            }
            return handle
          })
        }
        if (name === "openSync") {
          const fd = original(...args) as number
          remember(fd)
          return fd
        }
        const callback = args.at(-1)
        if (typeof callback === "function") {
          args[args.length - 1] = (error: unknown, fd: number) => {
            if (!error) remember(fd)
            callback(error, fd)
          }
        }
        return original(...args)
      })
    }
  }
  for (const name of ["close", "closeSync"]) {
    wrap(fs, name, (original, args) => {
      if (typeof args[0] === "number") descriptors.delete(args[0])
      return original(...args)
    })
  }
  wrap(Bun, "file", (original, args) => {
    const file = original(...args) as Bun.BunFile
    for (const method of ["writer", "delete"]) {
      wrap(file, method, (invoke, values) => {
        check(args[0], `BunFile.${method}`, false, method === "delete")
        return invoke(...values)
      })
    }
    return file
  })
  wrap(Bun, "write", (original, args) => {
    const destination = args[0]
    check(destination instanceof Blob && "name" in destination ? destination.name : destination, "Bun.write")
    return original(...args)
  })
  return { violations }
}

/** Each test process owns exactly one temporary directory; PATH is deliberately unchanged. */
export function isolateTestHome(): () => void {
  // Capture these before sanitizing AMIRA_* or changing os.homedir()'s environment.
  const roots = new Set([path.join(os.homedir(), ".amira")])
  for (const home of [process.env.HOME, process.env.USERPROFILE]) {
    if (home) roots.add(path.join(home, ".amira"))
  }
  if (process.env.AMIRA_HOME) roots.add(path.resolve(process.env.AMIRA_HOME))
  const { violations } = guardTestHome([...roots])

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "amira-test-home-"))
  const amira = path.join(home, ".amira")
  const config = path.join(home, ".config")
  fs.mkdirSync(amira)
  fs.mkdirSync(config)
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("AMIRA_") && !name.startsWith("AMIRA_LIVE_")) delete process.env[name]
  }
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.AMIRA_HOME = amira
  process.env.XDG_CONFIG_HOME = config
  if (process.platform === "win32") {
    const drive = path.parse(home).root.replace(/[\\/]$/, "")
    process.env.HOMEDRIVE = drive
    process.env.HOMEPATH = home.slice(drive.length)
  }

  const finish = () => {
    try {
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    } catch (error) {
      // Windows standbys can still hold their startup directory until the worker exits.
      // Retry at process exit too; a locked *temporary* home is not a real-home write.
      if (
        process.platform !== "win32" ||
        !["EBUSY", "EPERM", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")
      ) {
        throw error
      }
    }
    if (violations.length) throw new Error(violations.join("\n"))
  }
  process.on("exit", () => {
    try {
      finish()
    } catch (error) {
      console.error(error)
      process.exitCode = 1
    }
  })
  // Bun's test runner does not reliably run exit listeners. Register the returned
  // teardown as a global preload afterAll hook, so caught violations still fail tests.
  return finish
}
