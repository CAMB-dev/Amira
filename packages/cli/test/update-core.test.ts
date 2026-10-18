import { afterEach, expect, test } from "bun:test"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { tryFileLock } from "@amira/core"
import { releaseKeySource } from "../../../scripts/set-release-key.ts"
import { cleanupInstall, extractExecutable, probeExecutable, swapExecutable } from "../src/update/files.ts"
import { createUpdater, type UpdaterOptions } from "../src/update/index.ts"
import { installDisabledReason, readInstall } from "../src/update/install.ts"
import { manifestUrl, verifyReleaseManifest } from "../src/update/manifest.ts"
import { compareVersions, isPatchUpdate, isReleaseVersion, parseVersion } from "../src/update/semver.ts"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const keys = generateKeyPairSync("ed25519")
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString()
const target = "bun-windows-x64-baseline"
const archive = Buffer.from("fixture executable archive")
function manifest(version = "1.2.4", overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version,
    channel: "stable",
    artifacts: [
      {
        target,
        file: `amira-${target}.zip`,
        size: archive.length,
        sha256: createHash("sha256").update(archive).digest("hex"),
      },
    ],
    ...overrides,
  })
}
function signature(bytes: string) {
  return sign(null, Buffer.from(bytes), keys.privateKey).toString("base64")
}

async function fixture(overrides: UpdaterOptions = {}, release = manifest()) {
  const root = await mkdtemp(path.join(tmpdir(), "amira-update-test-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const bin = path.join(root, "bin", "amira.exe")
  await mkdir(path.dirname(bin), { recursive: true })
  await mkdir(path.join(root, "versions", "1.2.3"), { recursive: true })
  await writeFile(bin, "1.2.3")
  await writeFile(path.join(root, "versions", "1.2.3", "amira.exe"), "1.2.3")
  const record = { kind: "single-file" as const, version: "1.2.3", channel: "stable" as const, target, bin }
  await writeFile(path.join(root, "install.json"), JSON.stringify(record))
  const requests: string[] = []
  let servedRelease = release
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname
      requests.push(pathname)
      if (pathname === "/manifest.json") return new Response(servedRelease)
      if (pathname === "/manifest.json.sig") return new Response(signature(servedRelease))
      if (pathname === "/archive") return new Response(archive)
      return new Response("missing", { status: 404 })
    },
  })
  cleanups.push(() => server.stop(true))
  const options: UpdaterOptions = {
    version: "1.2.3",
    target,
    installRoot: root,
    bin,
    executable: bin,
    platform: "win32",
    env: {},
    publicKey,
    manifestUrl: () => `${server.url}manifest.json`,
    artifactUrl: () => `${server.url}archive`,
    extract: async (_archive, directory, name) => {
      await writeFile(path.join(directory, name), "1.2.4")
    },
    probe: async (file) => (await readFile(file, "utf8")).split(/\s+/)[0]!,
    ...overrides,
  }
  return {
    root,
    bin,
    record,
    requests,
    options,
    updater: createUpdater(options),
    setRelease: (value: string) => {
      servedRelease = value
    },
  }
}

test("only a marked executable inside the managed layout can self-update", async () => {
  const f = await fixture()
  expect(await f.updater.disabledReason()).toBeUndefined()
  await rm(path.join(f.root, "install.json"))
  expect(await f.updater.disabledReason()).toContain("not a self-managed")
  expect(f.requests).toEqual([])
})

test("install detection rejects arbitrary release paths, marker target and bin mismatches", async () => {
  const f = await fixture()
  const options = { ...f.options, version: "1.2.3", target }
  const outside = path.join(f.root, "arbitrary.exe")
  await writeFile(outside, "1.2.3")
  expect(await installDisabledReason({ ...options, executable: outside })).toContain("not a self-managed")
  await writeFile(path.join(f.root, "install.json"), JSON.stringify({ ...f.record, target: "bun-linux-x64" }))
  await expect(readInstall(options)).rejects.toThrow("Invalid self-managed")
  await writeFile(path.join(f.root, "install.json"), JSON.stringify({ ...f.record, bin: outside }))
  await expect(readInstall(options)).rejects.toThrow("Invalid self-managed")
})

test("development, source, zero versions and package manager installs never check", async () => {
  const f = await fixture()
  for (const version of ["0.0.0", "0.0.0-rc.1", "1.2.3-dev.2", "dev"]) {
    expect(await createUpdater({ ...f.options, version }).disabledReason()).toContain("Development")
  }
  expect(await createUpdater({ ...f.options, executable: "/usr/bin/bun" }).disabledReason()).toContain(
    "Development",
  )
  for (const [executable, command] of [
    ["/usr/lib/node_modules/amira-linux-x64/bin/amira", "npm i -g amira"],
    ["/home/test/.bun/install/global/node_modules/amira-linux-x64/bin/amira", "bun add -g amira"],
    ["/home/test/.local/share/pnpm/global/5/node_modules/amira-linux-x64/bin/amira", "pnpm add -g amira"],
  ]) {
    const updater = createUpdater({ ...f.options, executable })
    expect(await updater.disabledReason()).toContain(command!)
    await expect(updater.check()).rejects.toThrow(command!)
  }
  expect(f.requests).toEqual([])
})

test("no compiled key disables update checks without making requests", async () => {
  const f = await fixture({ publicKey: "" })
  expect(await f.updater.disabledReason()).toContain("no release public key")
  await expect(f.updater.check()).rejects.toThrow("no release public key")
  await expect(f.updater.update()).rejects.toThrow("no release public key")
  expect(f.requests).toEqual([])
})

test("signed manifest rejects missing signatures, wrong keys and tampered bytes", () => {
  const bytes = manifest()
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()
  for (const [body, sig, key] of [
    [bytes, "", publicKey],
    [bytes, signature(bytes), other],
    [bytes.replace("1.2.4", "1.2.5"), signature(bytes), publicKey],
  ]) {
    expect(() => verifyReleaseManifest(Buffer.from(body!), sig!, key!)).toThrow(
      "signature verification failed",
    )
  }
  expect(verifyReleaseManifest(Buffer.from(bytes), signature(bytes), publicKey).version).toBe("1.2.4")
})

test("even signed metadata rejects traversal, duplicate targets and stable prereleases", () => {
  const bad = [
    manifest("../escape"),
    manifest("1.2.4-rc.1"),
    manifest("1.2.4", { artifacts: [{ target, file: "../amira.exe", size: 1, sha256: "0".repeat(64) }] }),
  ]
  const good = JSON.parse(manifest())
  bad.push(JSON.stringify({ ...good, artifacts: [...good.artifacts, ...good.artifacts] }))
  for (const bytes of bad)
    expect(() => verifyReleaseManifest(Buffer.from(bytes), signature(bytes), publicKey)).toThrow()
})

test("checks use direct signed manifest URLs and require the requested channel", async () => {
  const f = await fixture()
  expect(await f.updater.check()).toEqual({ version: "1.2.4", channel: "stable" })
  expect(f.requests.sort()).toEqual(["/manifest.json", "/manifest.json.sig"])
  await expect(f.updater.check("next")).rejects.toThrow("channel")
  expect(manifestUrl("stable")).toBe(
    "https://github.com/CAMB-dev/Amira/releases/latest/download/manifest.json",
  )
  expect(manifestUrl("next")).toBe(
    "https://raw.githubusercontent.com/CAMB-dev/Amira/update-channels/next/manifest.json",
  )
  for (const installer of ["install.sh", "install.ps1"]) {
    const source = await readFile(new URL(`../../../${installer}`, import.meta.url), "utf8")
    expect(source).toContain(manifestUrl("next").replace("/manifest.json", ""))
  }
})

test("updates stage, hash, probe and swap, then rollback to the kept version", async () => {
  const f = await fixture()
  expect(await f.updater.update()).toBe("1.2.4")
  expect(await readFile(f.bin, "utf8")).toBe("1.2.4")
  expect(JSON.parse(await readFile(path.join(f.root, "install.json"), "utf8"))).toMatchObject({
    version: "1.2.4",
    previousVersion: "1.2.3",
  })
  expect((await readdir(f.root)).some((entry) => entry.startsWith(".update-"))).toBe(false)
  expect(await f.updater.rollback()).toBe("1.2.3")
  expect(await readFile(f.bin, "utf8")).toBe("1.2.3")
})

test("a moving channel cannot turn a checked patch into an automatic minor update", async () => {
  const f = await fixture()
  expect(await f.updater.check()).toEqual({ version: "1.2.4", channel: "stable" })
  f.setRelease(manifest("1.3.0"))
  expect(await f.updater.update()).toBe("1.2.4")
  expect(f.requests.filter((request) => request === "/manifest.json")).toHaveLength(1)
})

test("failed activation restores the bin, removes the unpublished version and allows retry", async () => {
  const f = await fixture()
  let fail = true
  const updater = createUpdater({
    ...f.options,
    swap: async (...args) => {
      if (fail) throw new Error("swap denied")
      await swapExecutable(...args)
    },
  })
  await expect(updater.update()).rejects.toThrow("swap denied")
  expect(await readFile(f.bin, "utf8")).toBe("1.2.3")
  expect(await readdir(path.join(f.root, "versions"))).toEqual(["1.2.3"])
  fail = false
  expect(await updater.update()).toBe("1.2.4")
})

test("interrupted activation reuses only an identical authenticated version directory", async () => {
  const f = await fixture()
  const directory = path.join(f.root, "versions", "1.2.4")
  await mkdir(directory)
  await writeFile(path.join(directory, "amira.exe"), "1.2.4")
  expect(await f.updater.update()).toBe("1.2.4")
  expect(await readFile(f.bin, "utf8")).toBe("1.2.4")

  const different = await fixture()
  const altered = path.join(different.root, "versions", "1.2.4")
  await mkdir(altered)
  await writeFile(path.join(altered, "amira.exe"), "untrusted")
  await expect(different.updater.update()).rejects.toThrow("differs")
  expect(await readFile(different.bin, "utf8")).toBe("1.2.3")
  expect(await readFile(path.join(altered, "amira.exe"), "utf8")).toBe("untrusted")
})

test("rollback enforces minimumVersion under its lock before probing or swapping", async () => {
  const f = await fixture()
  await mkdir(path.join(f.root, "versions", "1.2.2"))
  await writeFile(path.join(f.root, "versions", "1.2.2", "amira.exe"), "1.2.2")
  await writeFile(
    path.join(f.root, "install.json"),
    JSON.stringify({ ...f.record, previousVersion: "1.2.2" }),
  )
  let probes = 0
  let swaps = 0
  const updater = createUpdater({
    ...f.options,
    probe: async (...args) => {
      probes++
      return f.options.probe!(...args)
    },
    swap: async (...args) => {
      swaps++
      await swapExecutable(...args)
    },
  })
  await expect(updater.rollback("1.2.3")).rejects.toThrow("updates.minimumVersion")
  expect(probes).toBe(0)
  expect(swaps).toBe(0)
  expect(await readFile(f.bin, "utf8")).toBe("1.2.3")
  expect(JSON.parse(await readFile(path.join(f.root, "install.json"), "utf8")).version).toBe("1.2.3")
  expect(f.requests).toEqual([])

  const lock = tryFileLock(path.join(f.root, "update.lock"), 10 * 60_000, undefined, true)!
  try {
    await expect(updater.rollback("1.2.3")).rejects.toThrow("already in progress")
  } finally {
    lock.release()
  }
  expect(await updater.rollback("1.2.2")).toBe("1.2.2")
})

test("local rollback remains available without a release key or network", async () => {
  const f = await fixture()
  await f.updater.update()
  const before = f.requests.length
  expect(await createUpdater({ ...f.options, publicKey: "", env: { AMIRA_OFFLINE: "1" } }).rollback()).toBe(
    "1.2.3",
  )
  expect(f.requests).toHaveLength(before)
})

test.each(["update", "rollback"] as const)("shutdown drains local %s activation", async (command) => {
  const f = await fixture()
  if (command === "rollback") await f.updater.update()
  const expected = command === "rollback" ? "1.2.3" : "1.2.4"
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const updater = createUpdater({
    ...f.options,
    swap: async (...args) => {
      entered.resolve()
      await release.promise
      await swapExecutable(...args)
    },
  })
  const updating = updater[command]()
  await entered.promise
  let stopped = false
  const stopping = updater.stop().then(() => {
    stopped = true
  })
  await Bun.sleep(0)
  expect(stopped).toBe(false)
  release.resolve()
  await stopping
  expect(await updating).toBe(expected)
  await expect(updater.check()).rejects.toThrow("stopping")
  expect(await readFile(f.bin, "utf8")).toBe(expected)
})

test("hash mismatch never extracts, probes or changes the installed executable", async () => {
  const parsed = JSON.parse(manifest())
  parsed.artifacts[0].sha256 = "0".repeat(64)
  let extracted = false
  const f = await fixture(
    {
      extract: async () => {
        extracted = true
      },
    },
    JSON.stringify(parsed),
  )
  await expect(f.updater.update()).rejects.toThrow("SHA-256")
  expect(extracted).toBe(false)
  expect(await readFile(f.bin, "utf8")).toBe("1.2.3")
  expect(await readdir(path.join(f.root, "versions"))).toEqual(["1.2.3"])
})

test("version probe mismatch leaves the original install intact and removes staging", async () => {
  const f = await fixture({ probe: async () => "99.0.0" })
  await expect(f.updater.update()).rejects.toThrow("version does not match")
  expect(await readFile(f.bin, "utf8")).toBe("1.2.3")
  expect((await readdir(f.root)).filter((entry) => entry.startsWith(".update-"))).toEqual([])
})

test("exclusive update lock prevents both checks and changes during contention", async () => {
  const f = await fixture()
  const lock = tryFileLock(path.join(f.root, "update.lock"), 10 * 60_000, undefined, true)!
  expect(lock).toBeDefined()
  try {
    await expect(f.updater.check()).rejects.toThrow("already in progress")
    await expect(f.updater.update()).rejects.toThrow("already in progress")
    await expect(f.updater.rollback()).rejects.toThrow("already in progress")
    expect(f.requests).toEqual([])
  } finally {
    lock.release()
  }
  expect(await f.updater.check()).toEqual({ version: "1.2.4", channel: "stable" })
})

test("Windows swap renames before copying and restores even a partial failed copy", async () => {
  const f = await fixture()
  const source = path.join(f.root, "new.exe")
  await writeFile(source, "1.2.4")
  const calls: string[] = []
  await expect(
    swapExecutable(source, f.bin, "win32", {
      rename: async (from, to) => {
        calls.push(`rename:${path.basename(from.toString())}`)
        await rename(from, to)
      },
      copyFile: async (_from, to) => {
        calls.push("copy")
        await writeFile(to, "partial")
        throw new Error("copy denied")
      },
      rm,
      symlink,
    }),
  ).rejects.toThrow("copy denied")
  expect(calls[0]).toBe("rename:amira.exe")
  expect(calls[1]).toBe("copy")
  expect(calls[2]).toMatch(/^rename:amira.exe.old.\d+.\d+$/)
  expect(await readFile(f.bin, "utf8")).toBe("1.2.3")
})

test("Windows swap reports the recoverable old path if restore also fails", async () => {
  const f = await fixture()
  let renames = 0
  await expect(
    swapExecutable("unused", f.bin, "win32", {
      rename: async (from, to) => {
        if (++renames > 1) throw new Error("restore denied")
        await rename(from, to)
      },
      copyFile: async () => {
        throw new Error("copy denied")
      },
      rm,
      symlink,
    }),
  ).rejects.toThrow("previous executable is at")
  expect((await readdir(path.dirname(f.bin))).some((name) => name.startsWith("amira.exe.old."))).toBe(true)
})

test("cleanup keeps three newest versions and removes only matching old executable files", async () => {
  const f = await fixture()
  for (const version of ["1.2.0", "1.2.1", "1.2.2", "1.2.4"])
    await mkdir(path.join(f.root, "versions", version))
  const old = `${f.bin}.old.123.456`
  await writeFile(old, "old")
  await writeFile(`${f.bin}.old.user`, "keep")
  await cleanupInstall(f.root, f.bin, { ...f.record, version: "1.2.4", previousVersion: "1.2.3" })
  expect((await readdir(path.join(f.root, "versions"))).sort()).toEqual(["1.2.2", "1.2.3", "1.2.4"])
  expect(await Bun.file(old).exists()).toBe(false)
  expect(await Bun.file(`${f.bin}.old.user`).exists()).toBe(true)
})

test("all update-disable and offline switches stop core networking; explicit off values allow checks", async () => {
  const f = await fixture()
  for (const name of ["AMIRA_DISABLE_UPDATES", "AMIRA_OFFLINE"]) {
    await expect(createUpdater({ ...f.options, env: { [name]: "1" } }).check()).rejects.toThrow(name)
  }
  expect(f.requests).toEqual([])
  for (const value of ["", "0", "false", "FALSE"])
    await expect(
      createUpdater({ ...f.options, env: { AMIRA_DISABLE_UPDATES: value, AMIRA_OFFLINE: value } }).check(),
    ).resolves.toMatchObject({ version: "1.2.4" })
  // Disabling automatic updates must not disable explicit user-requested updates.
  await expect(
    createUpdater({ ...f.options, env: { AMIRA_DISABLE_AUTOUPDATE: "1" } }).check(),
  ).resolves.toMatchObject({ version: "1.2.4" })
})

test("Unix installs are recognized through the canonical version executable", async () => {
  const f = await fixture()
  const executable = path.join(f.root, "versions", "1.2.3", "amira")
  const bin = path.join(f.root, "unix-bin", "amira")
  await writeFile(executable, "1.2.3")
  await writeFile(
    path.join(f.root, "install.json"),
    JSON.stringify({ ...f.record, bin, target: "bun-linux-x64" }),
  )
  const options = {
    ...f.options,
    version: "1.2.3",
    target: "bun-linux-x64",
    platform: "linux" as const,
    executable,
    bin,
  }
  expect(await installDisabledReason(options)).toBeUndefined()
})

test("Unix swap stages a symlink before one atomic rename without touching a running image", async () => {
  const f = await fixture()
  const operations: string[] = []
  await swapExecutable("/version/amira", f.bin, "linux", {
    symlink: async (source, temporary) => {
      operations.push(`link:${source}`)
      expect(temporary.toString()).toContain(".new.")
    },
    rename: async (_temporary, destination) => {
      operations.push(`rename:${destination}`)
    },
    rm: async () => {
      operations.push("cleanup")
    },
    copyFile: async () => {
      throw new Error("Unix must not copy over a running image")
    },
  })
  expect(operations).toEqual(["link:/version/amira", `rename:${f.bin}`, "cleanup"])
})

test("real archive extraction accepts only one regular executable and real probes read a version", async () => {
  const f = await fixture()
  const archive = path.join(f.root, "fixture.tar")
  const extracted = path.join(f.root, "real-extracted")
  await mkdir(extracted)
  await writeFile(archive, await new Bun.Archive({ amira: "fixture executable" }).bytes())
  await extractExecutable(archive, extracted, "amira")
  expect(await readFile(path.join(extracted, "amira"), "utf8")).toBe("fixture executable")
  await writeFile(
    archive,
    await new Bun.Archive({ amira: "fixture executable", extra: "not allowed" }).bytes(),
  )
  await expect(extractExecutable(archive, extracted, "amira")).rejects.toThrow("only the executable")
  expect(await probeExecutable(process.execPath)).toMatch(/^\d+\.\d+\.\d+/)
})

test("SemVer policy distinguishes patch, minor, major, prereleases and development builds", () => {
  expect(isPatchUpdate("1.2.3", "1.2.4")).toBe(true)
  expect(isPatchUpdate("1.2.3", "1.3.0")).toBe(false)
  expect(isPatchUpdate("1.2.3", "2.0.0")).toBe(false)
  expect(isPatchUpdate("1.2.4", "1.2.3")).toBe(false)
  expect(compareVersions("1.2.3-rc.10", "1.2.3-rc.2")).toBeGreaterThan(0)
  expect(compareVersions("1.2.3", "1.2.3-rc.2")).toBeGreaterThan(0)
  expect(compareVersions("1.2.3+build.1", "1.2.3+build.2")).toBe(0)
  expect(parseVersion("1.2.3-01")).toBeUndefined()
  expect(isReleaseVersion("1.2.3-dev")).toBe(false)
  expect(isReleaseVersion("0.0.0+build.1")).toBe(false)
  expect(isReleaseVersion("1.2.3-rc.1")).toBe(true)
})

test("key setter accepts only Ed25519 public SPKI PEMs and never private keys", () => {
  expect(releaseKeySource(publicKey)).toContain(JSON.stringify(publicKey))
  const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  expect(() => releaseKeySource(privatePem)).toThrow("not a private key")
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 })
    .publicKey.export({ type: "spki", format: "pem" })
    .toString()
  expect(() => releaseKeySource(rsa)).toThrow("Ed25519 public key")
})
