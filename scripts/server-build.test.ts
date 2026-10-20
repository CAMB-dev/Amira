import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { targets } from "./build-metadata.ts"
import { buildServer, serverBuildOptions, serverCompileOptions } from "./build-server.ts"
import { assertServerModule, serverOnlyGraph } from "./server-build-graph.ts"
import { serverTargets, validateServerMetadata } from "./server-build-metadata.ts"

const buildId = "0123456789abcdef0123456789abcdef01234567"
const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "amira-server-build-"))
  temporary.push(directory)
  for (const name of ["local-home", "remote-home", "workspace"]) {
    await mkdir(path.join(directory, name))
  }
  return directory
}

test("production servers use only baseline Linux x64 and ARM64; CLI retains seven targets", () => {
  expect(serverBuildOptions(["--all"]).targets).toEqual([...serverTargets])
  expect(serverBuildOptions([], "linux", "x64").targets).toEqual(["bun-linux-x64-baseline"])
  expect(serverBuildOptions([], "linux", "arm64").targets).toEqual(["bun-linux-arm64"])
  expect(serverBuildOptions([]).buildId).toBe("development-unverified")
  expect(serverBuildOptions(["--build-id", buildId]).buildId).toBe(buildId)
  expect(targets).toHaveLength(7)
  for (const target of ["bun-windows-x64", "bun-linux-x64", "bun-darwin-arm64", "../bad"]) {
    expect(() => serverBuildOptions(["--target", target])).toThrow()
  }
  for (const argv of [
    ["--version", "../bad"],
    ["--channel", "nightly"],
    ["--target"],
    ["--unknown"],
    ["--build-id"],
    ["--build-id", "1.2.3"],
  ]) {
    expect(() => serverBuildOptions(argv)).toThrow()
  }
})

test("native Windows test target is explicit and cannot enter production metadata", () => {
  const options = serverBuildOptions(["--native-windows-test"], "win32", "x64")
  expect(options.nativeWindowsTest).toBe(true)
  expect(options.targets).toEqual(["bun-windows-x64"])
  expect(options.buildId).toStartWith("development-")
  expect(serverBuildOptions(["--native-windows-test", "--build-id", buildId], "win32", "x64").buildId).toBe(
    `development-native-windows-${buildId}`,
  )
  expect(() => validateServerMetadata({ ...options, product: "amira-server" })).toThrow()
  for (const [platform, arch] of [
    ["linux", "x64"],
    ["win32", "arm64"],
  ] as const) {
    expect(() => serverBuildOptions(["--native-windows-test"], platform, arch)).toThrow()
  }
  expect(() => serverBuildOptions(["--native-windows-test", "--all"], "win32", "x64")).toThrow()
  expect(() =>
    serverBuildOptions(["--native-windows-test", "--target", "bun-windows-x64"], "win32", "x64"),
  ).toThrow()
})

test("fake Linux compilation packages raw executables and does not replace CLI provenance", async () => {
  const directory = await fixture()
  await writeFile(path.join(directory, "build.json"), "CLI metadata")
  await writeFile(path.join(directory, "SHA256SUMS"), "CLI checksums")
  const configurations: Bun.BuildConfig[] = []
  await buildServer(
    ["--all", "--version", "1.2.3-nightly.20261019", "--channel", "next", "--build-id", buildId],
    {
      directory,
      compile: async (options) => {
        configurations.push(options)
        await writeFile((options.compile as { outfile: string }).outfile, "fake Linux executable")
        return { success: true, logs: [] }
      },
    },
  )
  expect(configurations).toHaveLength(2)
  for (const configuration of configurations) {
    expect(configuration.entrypoints).toEqual([
      "build/entries/amira-server.ts",
      "build/entries/worker.ts",
      "build/entries/stdout-worker.ts",
    ])
    expect(configuration.compile).not.toHaveProperty("assets")
    expect(configuration.compile).toMatchObject({ autoloadDotenv: false, autoloadBunfig: false })
    expect(configuration.plugins).toHaveLength(1)
    expect(configuration.define?.AMIRA_SERVER_BUILD_ID).toBe(JSON.stringify(buildId))
  }
  expect(JSON.parse(await readFile(path.join(directory, "server-build.json"), "utf8"))).toEqual({
    product: "amira-server",
    version: "1.2.3-nightly.20261019",
    buildId,
    channel: "next",
    targets: [...serverTargets],
  })
  expect(await readFile(path.join(directory, "SERVER_SHA256SUMS"), "utf8")).toContain(
    "amira-server-bun-linux-arm64",
  )
  expect(await readFile(path.join(directory, "build.json"), "utf8")).toBe("CLI metadata")
  expect(await readFile(path.join(directory, "SHA256SUMS"), "utf8")).toBe("CLI checksums")
})

test("failed rebuild invalidates server metadata, signatures and checksums before compile", async () => {
  const directory = await fixture()
  const names = ["server-build.json", "server-manifest.json", "server-manifest.json.sig", "SERVER_SHA256SUMS"]
  for (const name of names) await writeFile(path.join(directory, name), "stale")
  await expect(
    buildServer(["--all"], {
      directory,
      compile: async () => ({ success: false, logs: [new Error("fake failure")] }),
    }),
  ).rejects.toThrow("Server build failed")
  for (const name of names) expect(await Bun.file(path.join(directory, name)).exists()).toBe(false)
})

test("runtime graph rejects UI roots, aliases and assets, including Windows paths", () => {
  for (const file of [
    "@amira/tui",
    "@amira/tui-kit",
    "C:\\repo\\packages\\tui\\src\\app.ts",
    "/repo/packages/cli/src/main.ts",
    "/repo/packages/cli/src/print.ts",
    "/repo/packages/cli/src/print-markdown.ts",
    "/repo/packages/cli/themes/amira.json",
  ])
    expect(() => assertServerModule(file)).toThrow("Forbidden server dependency")
  expect(() => assertServerModule("/repo/packages/cli/src/server-main.ts")).not.toThrow()
  expect(
    serverCompileOptions("bun-linux-arm64", "fake", { version: "1.2.3", channel: "stable", buildId }).define
      ?.AMIRA_TARGET,
  ).toBe('"bun-linux-arm64"')
})

test("actual server runtime bundle excludes TUI and theme assets without compiling Linux", async () => {
  const result = await Bun.build({
    entrypoints: ["amira-server.ts", "worker.ts", "stdout-worker.ts"].map((entry) =>
      path.resolve(import.meta.dir, "../build/entries", entry),
    ),
    target: "bun",
    plugins: [serverOnlyGraph()],
  })
  expect(result.success, result.logs.map(String).join("\n")).toBe(true)
}, 30_000)
