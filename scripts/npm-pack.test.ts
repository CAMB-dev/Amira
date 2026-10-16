import { afterEach, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { npmPackOptions, npmTargets, stageNpmPackages } from "./npm-pack.ts"
import { generateManifest } from "./sign-manifest.ts"
import {
  SPAWN_TEST_TIMEOUT_MS,
  stopSpawn,
  waitForSpawnCondition,
  waitForSpawnExit,
  waitForSpawnWork,
} from "./spawn-test.ts"

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(targets: readonly string[] = npmTargets.map((platform) => platform.target)) {
  const directory = await mkdtemp(path.join(tmpdir(), "amira-npm-"))
  temporary.push(directory)
  const root = path.join(directory, "repo")
  const dist = path.join(directory, "build")
  await mkdir(root, { recursive: true })
  await mkdir(dist)
  await writeFile(path.join(root, "LICENSE"), "Apache-2.0 fixture\n")
  await writeFile(path.join(root, "NOTICE"), "Amira attribution fixture\n")
  await writeFile(
    path.join(dist, "build.json"),
    JSON.stringify({ version: "2.3.4-nightly.20261015.7", channel: "next", targets }),
  )
  for (const target of targets) {
    const folder = path.join(dist, `amira-${target}`)
    await mkdir(folder)
    await writeFile(path.join(folder, target.startsWith("bun-windows-") ? "amira.exe" : "amira"), target)
  }
  return { directory, root, dist }
}

async function manifest(directory: string) {
  return JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"))
}

async function files(directory: string) {
  return (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort()
}

test("stages six lean packages with exact build versions, baseline binaries and legal notices", async () => {
  const options = await fixture()
  const result = await stageNpmPackages(options)
  expect(result.version).toBe("2.3.4-nightly.20261015.7")
  expect(result.channel).toBe("next")
  expect(result.directory).toBe(path.join(options.dist, "npm"))
  expect(result.packages).toHaveLength(6)
  const main = result.packages[0]!
  expect(main.name).toBe("amira")
  const pkg = await manifest(main.directory)
  expect(pkg.version).toBe(result.version)
  expect(pkg.bin).toEqual({ amira: "bin/amira.js" })
  expect(pkg.engines).toEqual({ node: ">=18" })
  expect(pkg.type).toBe("commonjs")
  const launcher = await readFile(path.join(main.directory, "bin", "amira.js"), "utf8")
  expect(launcher).toContain(JSON.stringify(npmTargets))
  expect(launcher).not.toContain("AMIRA_NPM_PLATFORMS")
  expect(pkg.repository).toEqual({ type: "git", url: "git+https://github.com/CAMB-dev/Amira.git" })
  expect(pkg.homepage).toBe("https://github.com/CAMB-dev/Amira#readme")
  expect(pkg.license).toBe("Apache-2.0")
  expect(Object.keys(pkg.optionalDependencies).sort()).toEqual([
    "amira-darwin-arm64",
    "amira-darwin-x64",
    "amira-linux-arm64",
    "amira-linux-x64",
    "amira-win32-x64",
  ])
  expect(pkg.optionalDependencies).toEqual(
    Object.fromEntries(npmTargets.map((platform) => [platform.name, result.version])),
  )
  expect(pkg.dependencies).toBeUndefined()
  expect(pkg.scripts).toBeUndefined()
  expect(await files(main.directory)).toEqual([
    "LICENSE",
    "NOTICE",
    "README.md",
    "bin/amira.js",
    "package.json",
  ])
  for (const platform of npmTargets) {
    const staged = result.packages.find((item) => item.name === platform.name)!
    const platformPkg = await manifest(staged.directory)
    const executable = platform.os === "win32" ? "amira.exe" : "amira"
    expect(platformPkg.version).toBe(result.version)
    expect(platformPkg.os).toEqual([platform.os])
    expect(platformPkg.cpu).toEqual([platform.cpu])
    expect(platformPkg.libc).toEqual(platform.os === "linux" ? ["glibc"] : undefined)
    expect(platformPkg.repository).toEqual(pkg.repository)
    expect(platformPkg.homepage).toBe(pkg.homepage)
    expect(platformPkg.license).toBe(pkg.license)
    expect(platformPkg.dependencies).toBeUndefined()
    expect(platformPkg.scripts).toBeUndefined()
    expect(await files(staged.directory)).toEqual([
      "LICENSE",
      "NOTICE",
      "README.md",
      `bin/${executable}`,
      "package.json",
    ])
    expect(await readFile(path.join(staged.directory, "bin", executable), "utf8")).toBe(platform.target)
    expect(await readFile(path.join(staged.directory, "LICENSE"), "utf8")).toBe("Apache-2.0 fixture\n")
    expect(await readFile(path.join(staged.directory, "NOTICE"), "utf8")).toBe("Amira attribution fixture\n")
    if (process.platform !== "win32")
      expect((await stat(path.join(staged.directory, "bin", executable))).mode & 0o111).toBe(0o111)
  }
})

test("partial staging is explicit, clears stale staged packages and never rewrites binaries", async () => {
  const options = await fixture()
  await stageNpmPackages(options)
  await rm(path.join(options.root, "NOTICE"))
  const result = await stageNpmPackages({ ...options, targets: ["bun-linux-x64-baseline"] })
  expect(result.packages.map((item) => item.name)).toEqual(["amira", "amira-linux-x64"])
  expect((await readdir(result.directory)).sort()).toEqual(["amira", "amira-linux-x64"])
  expect(await files(result.packages[1]!.directory)).toEqual([
    "LICENSE",
    "README.md",
    "bin/amira",
    "package.json",
  ])
  expect(await readFile(path.join(options.dist, "amira-bun-linux-x64-baseline", "amira"), "utf8")).toBe(
    "bun-linux-x64-baseline",
  )
})

test("default staging fails for absent platforms and partial mode only accepts npm baseline targets", async () => {
  const options = await fixture(["bun-linux-x64-baseline"])
  await expect(stageNpmPackages(options)).rejects.toThrow("missing target")
  const result = await stageNpmPackages({
    ...options,
    ...npmPackOptions(["--target", "bun-linux-x64-baseline"]),
  })
  await expect(stageNpmPackages({ ...options, targets: ["bun-linux-x64"] })).rejects.toThrow(
    "Unsupported npm target",
  )
  await expect(stageNpmPackages({ ...options, targets: [] })).rejects.toThrow("at least one")
  await rm(path.join(options.dist, "amira-bun-linux-x64-baseline", "amira"))
  await expect(stageNpmPackages({ ...options, targets: ["bun-linux-x64-baseline"] })).rejects.toThrow()
  expect(await manifest(result.packages[0]!.directory)).toHaveProperty("name", "amira")
  for (const argv of [
    ["--target"],
    ["--target", "--all"],
    ["--target", "bun-windows-x64"],
    ["--version", "1.0.0"],
  ]) {
    expect(() => npmPackOptions(argv)).toThrow()
  }
  expect(npmPackOptions([])).toEqual({})
})

test("staging requires valid build metadata rather than falling back to source package versions", async () => {
  const options = await fixture(["bun-linux-x64-baseline"])
  for (const metadata of [
    {},
    { version: "../bad", channel: "stable", targets: [] },
    { version: "1.2.3", channel: "nightly", targets: [] },
    { version: "1.2.3", channel: "stable", targets: "bun-linux-x64-baseline" },
  ]) {
    await writeFile(path.join(options.dist, "build.json"), JSON.stringify(metadata))
    await expect(stageNpmPackages({ ...options, targets: ["bun-linux-x64-baseline"] })).rejects.toThrow(
      "Invalid build",
    )
  }
  await rm(path.join(options.dist, "build.json"))
  await expect(stageNpmPackages({ ...options, targets: ["bun-linux-x64-baseline"] })).rejects.toThrow()
  expect(existsSync(path.join(options.dist, "npm"))).toBe(false)
})

test("staging and signing share semver, channel and target validation", async () => {
  const options = await fixture(["bun-linux-x64-baseline"])
  const valid = { version: "1.2.3-rc.1+001", channel: "next", targets: ["bun-linux-x64-baseline"] }
  const metadata = path.join(options.dist, "build.json")
  await writeFile(path.join(options.dist, "amira-bun-linux-x64-baseline.tar.gz"), "archive fixture")
  await writeFile(metadata, JSON.stringify(valid))
  expect((await stageNpmPackages({ ...options, targets: valid.targets })).version).toBe(valid.version)
  expect(JSON.parse(await generateManifest(options.dist)).version).toBe(valid.version)
  for (const invalid of [
    { ...valid, version: "1.2.3-rc.01" },
    { ...valid, version: "1.2.3\n" },
    { ...valid, channel: "nightly" },
    { ...valid, targets: [] },
    { ...valid, targets: ["bun-freebsd-x64"] },
    { ...valid, targets: ["bun-linux-x64-baseline", "bun-linux-x64-baseline"] },
  ]) {
    await writeFile(metadata, JSON.stringify(invalid))
    await expect(stageNpmPackages({ ...options, targets: valid.targets })).rejects.toThrow("Invalid build")
    await expect(generateManifest(options.dist)).rejects.toThrow("Invalid build")
  }
})

const node = Bun.which("node")
const runtimes = [
  { name: "Bun", executable: process.execPath },
  ...(node ? [{ name: "Node", executable: node }] : []),
]

async function launcherFixture() {
  const options = await fixture(["bun-linux-x64-baseline"])
  const result = await stageNpmPackages({ ...options, targets: ["bun-linux-x64-baseline"] })
  const main = result.packages[0]!.directory
  const script = path.join(options.directory, "fake-binary.cjs")
  await writeFile(
    script,
    `const fs = require("node:fs")\nconsole.log(JSON.stringify(process.argv.slice(2)))\nconsole.log(fs.readFileSync(0, "utf8"))\nconsole.error("fake stderr")\nprocess.exit(37)\n`,
  )
  return { ...options, main, script, launcher: path.join(main, "bin", "amira.js") }
}

async function run(argv: string[], env: Record<string, string | undefined> = {}, cwd?: string) {
  const child = Bun.spawn(argv, {
    cwd,
    env: { ...process.env, AMIRA_BINARY: "", ...env },
    stdin: new TextEncoder().encode("inherited stdin"),
    stdout: "pipe",
    stderr: "pipe",
  })
  try {
    const [stdout, stderr, code] = await waitForSpawnWork(
      "child output",
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        waitForSpawnExit(child, "launcher/package command"),
      ]),
    )
    return { stdout, stderr, code }
  } finally {
    await stopSpawn(child)
  }
}

for (const runtime of runtimes) {
  test(
    `${runtime.name} launcher honors AMIRA_BINARY, literal arguments, inherited stdio and exit code`,
    async () => {
      const fixture = await launcherFixture()
      const args = ["two words", "$(not-a-command)", "--flag=value", "日本語"]
      const result = await run([runtime.executable, fixture.launcher, fixture.script, ...args], {
        AMIRA_BINARY: runtime.executable,
      })
      expect(result.code).toBe(37)
      expect(result.stdout).toContain(JSON.stringify(args))
      expect(result.stdout).toContain("inherited stdin")
      expect(result.stderr).toContain("fake stderr")
    },
    SPAWN_TEST_TIMEOUT_MS,
  )

  test(
    `${runtime.name} launcher resolves a local platform package and reports missing package or override`,
    async () => {
      const fixture = await launcherFixture()
      const platform = npmTargets.find((item) => item.os === process.platform && item.cpu === process.arch)
      expect(platform).toBeDefined()
      const missing = await run([runtime.executable, fixture.launcher])
      expect(missing.code).toBe(1)
      expect(missing.stderr).toContain(platform!.name)
      expect(missing.stderr).toContain("optional dependencies")
      expect(missing.stderr).toContain("https://github.com/CAMB-dev/Amira/releases")
      const override = await run([runtime.executable, fixture.launcher], {
        AMIRA_BINARY: path.join(fixture.directory, "missing.exe"),
      })
      expect(override.code).toBe(1)
      expect(override.stderr).toContain("could not start")
      expect(override.stderr).not.toContain("could not find")
      const folder = path.join(fixture.main, "node_modules", platform!.name)
      await mkdir(path.join(folder, "bin"), { recursive: true })
      await writeFile(
        path.join(folder, "package.json"),
        JSON.stringify({ name: platform!.name, version: "1.0.0" }),
      )
      const executable = path.join(folder, "bin", process.platform === "win32" ? "amira.exe" : "amira")
      if (process.platform === "win32") {
        await copyFile(runtime.executable, executable)
      } else {
        // Test package lookup without requiring the host runtime to work after relocation.
        await writeFile(
          executable,
          `#!/bin/sh\nexec '${runtime.executable.replaceAll("'", "'\\''")}' "$@"\n`,
          {
            mode: 0o755,
          },
        )
      }
      const found = await run([runtime.executable, fixture.launcher, fixture.script, "platform argument"])
      expect(found.code, JSON.stringify(found)).toBe(37)
      expect(found.stdout).toContain('["platform argument"]')
      expect(found.stderr).toContain("fake stderr")
    },
    SPAWN_TEST_TIMEOUT_MS,
  )

  test.skipIf(process.platform === "win32").each(["SIGTERM", "SIGHUP"] as const)(
    `${runtime.name} launcher forwards %s and retains signal status`,
    async (signal) => {
      const fixture = await launcherFixture()
      const script = path.join(fixture.directory, "signals.cjs")
      await writeFile(
        script,
        `process.on("${signal}", () => { console.error("received ${signal}"); process.exit(42) }); setImmediate(() => console.log("ready")); setInterval(() => {}, 1000)\n`,
      )
      const child = Bun.spawn([runtime.executable, fixture.launcher, script], {
        env: { ...process.env, AMIRA_BINARY: runtime.executable },
        stdout: "pipe",
        stderr: "pipe",
      })
      try {
        let ready = ""
        const reading = (async () => {
          for await (const chunk of child.stdout) ready += new TextDecoder().decode(chunk)
        })()
        void reading.catch(() => undefined)
        await waitForSpawnCondition(`${runtime.name} signal handler ready`, () => ready.includes("ready\n"))
        expect(ready).toContain("ready\n")
        child.kill(signal)
        const code = await waitForSpawnExit(child, `${runtime.name} forwarded ${signal}`)
        await waitForSpawnWork("launcher stdout", reading)
        const stderr = await waitForSpawnWork("launcher stderr", new Response(child.stderr).text())
        expect(code, JSON.stringify({ signal: child.signalCode, stderr })).toBe(42)
        expect(stderr).toContain(`received ${signal}`)
      } finally {
        await stopSpawn(child)
      }
      const selfSignal = path.join(fixture.directory, "self-signal.cjs")
      await writeFile(selfSignal, `process.kill(process.pid, "${signal}")\n`)
      const signaled = Bun.spawn([runtime.executable, fixture.launcher, selfSignal], {
        env: { ...process.env, AMIRA_BINARY: runtime.executable },
        stdout: "ignore",
        stderr: "pipe",
      })
      try {
        await waitForSpawnExit(signaled, `${runtime.name} self ${signal}`)
        expect(signaled.signalCode).toBe(signal)
      } finally {
        await stopSpawn(signaled)
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
}

const npm = Bun.which("npm")
const npmCli = npm
  ? process.platform === "win32"
    ? path.join(path.dirname(npm), "node_modules", "npm", "bin", "npm-cli.js")
    : await realpath(npm)
  : undefined

test.skipIf(!node || !npmCli || !existsSync(npmCli))(
  "npm pack stays local and contains only declared package payloads",
  async () => {
    const options = await fixture(["bun-linux-x64-baseline"])
    const result = await stageNpmPackages({ ...options, targets: ["bun-linux-x64-baseline"] })
    for (const item of result.packages) {
      const packed = await run(
        [
          node!,
          npmCli!,
          "pack",
          "--json",
          "--offline",
          "--ignore-scripts",
          "--cache",
          path.join(options.directory, "cache"),
          "--userconfig",
          path.join(options.directory, "npmrc"),
          "--globalconfig",
          path.join(options.directory, "global-npmrc"),
          "--pack-destination",
          options.directory,
        ],
        {},
        item.directory,
      )
      expect(packed.code).toBe(0)
      const [pack] = JSON.parse(packed.stdout)
      expect(pack.name).toBe(item.name)
      expect(pack.version).toBe(result.version)
      expect(pack.files.map((file: { path: string }) => file.path).sort()).toEqual(
        await files(item.directory),
      )
      expect(existsSync(path.join(options.directory, pack.filename))).toBe(true)
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)
