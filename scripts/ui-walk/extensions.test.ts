import { afterEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { copyExtensions, extensionDirectory } from "./extensions.ts"
import { sessionRoot, start } from "./session.ts"
import { main } from "./walk.ts"

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function temporary() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ui-walk-extensions-"))
  directories.push(directory)
  return directory
}

test("copies repeatable extension directories and manifest entry points into independent homes", async () => {
  const directory = await temporary()
  const source = path.join(directory, "source")
  const plain = path.join(directory, "plain")
  await mkdir(source)
  await mkdir(plain)
  await writeFile(
    path.join(source, "amira-package.json"),
    JSON.stringify({
      name: "walk-test",
      extensions: ["first.ts", "second.ts"],
    }),
  )
  for (const file of ["first.ts", "second.ts"])
    await writeFile(path.join(source, file), "export default () => {}")
  await writeFile(path.join(plain, "index.ts"), "export default () => {}")
  await mkdir(path.join(source, ".git"))
  await writeFile(path.join(source, ".git", "ignored"), "not copied")
  const development = path.join(source, "node_modules", "@amira")
  await mkdir(development, { recursive: true })
  await symlink(plain, path.join(development, "api"), process.platform === "win32" ? "junction" : "dir")
  const homes = [path.join(directory, "one"), path.join(directory, "two")]
  const copies = await Promise.all(homes.map((home) => copyExtensions(home, [source, plain])))
  for (const [index, home] of homes.entries()) {
    expect(copies[index]).toEqual([
      path.join(home, "extensions/local-0/first.ts"),
      path.join(home, "extensions/local-0/second.ts"),
      path.join(home, "extensions/local-1/index.ts"),
    ])
    expect(await stat(path.join(home, "extensions/local-0/.git")).catch(() => undefined)).toBeUndefined()
    expect(
      await stat(path.join(home, "extensions/local-0/node_modules/@amira")).catch(() => undefined),
    ).toBeUndefined()
  }
  await writeFile(copies[0]![0]!, "changed in one session")
  expect(await readFile(copies[1]![0]!, "utf8")).toBe("export default () => {}")
  expect(await readFile(path.join(source, "first.ts"), "utf8")).toBe("export default () => {}")
  expect(await copyExtensions(path.join(directory, "default"))).toEqual([])
})

test("rejects invalid local directories before launching or claiming a session", async () => {
  const directory = await temporary()
  const name = `reject-${randomUUID()}`
  await writeFile(path.join(directory, "index.ts"), "export default () => {}")
  await expect(extensionDirectory(path.join(directory, "index.ts"))).rejects.toThrow("local directory")
  await expect(extensionDirectory(path.join(directory, "missing"))).rejects.toThrow()
  const options = { cols: 100, rows: 32, idleTimeout: 60_000, args: [] }
  await expect(start(name, { ...options, extensions: [path.join(directory, "missing")] })).rejects.toThrow()
  expect(await stat(`${sessionRoot(name)}.starting`).catch(() => undefined)).toBeUndefined()
  await expect(main(["start", name, "--", "--extension", directory])).rejects.toThrow("not allowed")
  await expect(extensionDirectory(path.join(os.homedir(), ".amira"))).rejects.toThrow("real Amira home")
})

test("rejects empty, escaping, missing and incompatible manifest entry points", async () => {
  const directory = await temporary()
  const manifest = path.join(directory, "package.json")
  await writeFile(path.join(directory, "index.ts"), "export default () => {}")
  for (const [amira, error] of [
    [{ extensions: [] }, "no extension entry points"],
    [{ extensions: ["../outside.ts"] }, "outside the package"],
    [{ extensions: ["missing.ts"] }, "ENOENT"],
    [{ engines: { amira: ">=999.0.0" } }, "needs Amira extension API"],
  ] as const) {
    await writeFile(manifest, JSON.stringify({ name: "walk-test", amira }))
    await expect(extensionDirectory(directory)).rejects.toThrow(error)
  }
  await rm(manifest)
  await rm(path.join(directory, "index.ts"))
  await expect(extensionDirectory(directory)).rejects.toThrow("no extension entry points")
  await mkdir(path.join(directory, "src"))
  await writeFile(path.join(directory, "src/index.ts"), "export default () => {}")
  expect(await extensionDirectory(directory)).toBe(directory)
})

test("rejects directory symlinks and copy-time escapes without following them", async () => {
  const directory = await temporary()
  const source = path.join(directory, "source")
  const outside = path.join(directory, "outside")
  await mkdir(source)
  await mkdir(outside)
  await writeFile(path.join(source, "index.ts"), "export default () => {}")
  await writeFile(path.join(outside, "private.txt"), "not copied")
  const link = path.join(directory, "link")
  await symlink(source, link, process.platform === "win32" ? "junction" : "dir")
  await expect(extensionDirectory(link)).rejects.toThrow("symlink")
  await symlink(outside, path.join(source, "escape"), process.platform === "win32" ? "junction" : "dir")
  const home = path.join(directory, "home")
  await expect(copyExtensions(home, [source])).rejects.toThrow("do not allow symlinks")
  expect(
    await stat(path.join(home, "extensions/local-0/escape/private.txt")).catch(() => undefined),
  ).toBeUndefined()
  expect(await readFile(path.join(outside, "private.txt"), "utf8")).toBe("not copied")
})
