import { chmod, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import pkg from "../packages/cli/package.json" with { type: "json" }
import { validateBuildMetadata } from "./build-metadata.ts"
import { serverOnlyGraph } from "./server-build-graph.ts"
import {
  type ServerBuildMetadata,
  serverArtifact,
  serverTargets,
  validateServerBuildId,
  validateServerMetadata,
} from "./server-build-metadata.ts"
import { generateServerChecksums } from "./server-manifest.ts"

export function serverBuildOptions(argv: string[], platform = process.platform, arch = process.arch) {
  let version = pkg.version
  let channel = "stable"
  let buildId = "development-unverified"
  let target: string = arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64-baseline"
  let all = false
  let nativeWindowsTest = false
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === "--all") {
      all = true
    } else if (flag === "--native-windows-test") {
      nativeWindowsTest = true
    } else {
      if (!["--version", "--channel", "--target", "--build-id"].includes(flag!)) {
        throw new Error(`Unknown server build option: ${flag}`)
      }
      const value = argv[++i]
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`)
      if (flag === "--build-id") buildId = value
      if (flag === "--version") version = value
      if (flag === "--channel") channel = value
      if (flag === "--target") target = value
    }
  }
  buildId = validateServerBuildId(buildId)
  if (nativeWindowsTest) {
    if (platform !== "win32" || arch !== "x64" || all || argv.includes("--target")) {
      throw new Error("Native Windows test builds require Windows x64 and no target selection")
    }
    // This target is deliberately never accepted by production metadata or manifests.
    const build = validateBuildMetadata({ version, channel, targets: ["bun-windows-x64"] })
    return {
      ...build,
      buildId: buildId.startsWith("development-") ? buildId : `development-native-windows-${buildId}`,
      nativeWindowsTest: true as const,
    }
  }
  const build = validateServerMetadata({
    product: "amira-server",
    buildId,
    version,
    channel,
    targets: all ? [...serverTargets] : [target],
  })
  return { ...build, nativeWindowsTest: false as const }
}

export function serverCompileOptions(
  target: Bun.Build.CompileTarget,
  outfile: string,
  metadata: { version: string; channel: string; buildId: string },
): Bun.BuildConfig {
  return {
    entrypoints: [
      "build/entries/amira-server.ts",
      "build/entries/worker.ts",
      "build/entries/stdout-worker.ts",
    ],
    compile: { target, outfile, autoloadDotenv: false, autoloadBunfig: false },
    plugins: [serverOnlyGraph()],
    minify: true,
    bytecode: true,
    format: "esm",
    define: {
      AMIRA_SERVER_BUILD_ID: JSON.stringify(validateServerBuildId(metadata.buildId)),
      AMIRA_VERSION: JSON.stringify(metadata.version),
      AMIRA_CHANNEL: JSON.stringify(metadata.channel),
      AMIRA_TARGET: JSON.stringify(target),
    },
  }
}

/** Compiler injection keeps Linux packaging tests offline on Windows. */
export async function buildServer(
  argv: string[],
  dependencies: {
    directory?: string
    compile?: (options: Bun.BuildConfig) => Promise<{ success: boolean; logs: unknown[] }>
  } = {},
) {
  const options = serverBuildOptions(argv)
  if (!dependencies.compile && !options.nativeWindowsTest && process.platform !== "linux") {
    throw new Error("Production server compilation requires Linux CI; use --native-windows-test on Windows")
  }
  const directory = dependencies.directory ?? path.resolve(import.meta.dir, "../dist")
  const compile = dependencies.compile ?? ((config) => Bun.build(config))
  await mkdir(directory, { recursive: true })
  if (!options.nativeWindowsTest) {
    // Invalidate provenance before replacing any raw executable, including on a failed rebuild.
    for (const name of [
      "server-build.json",
      "server-manifest.json",
      "server-manifest.json.sig",
      "SERVER_SHA256SUMS",
    ]) {
      await rm(path.join(directory, name), { force: true })
    }
  }
  for (const target of options.targets) {
    const outfile = path.join(
      directory,
      options.nativeWindowsTest
        ? "amira-server-native-test.exe"
        : serverArtifact(target as ServerBuildMetadata["targets"][number]),
    )
    const result = await compile(serverCompileOptions(target, outfile, options))
    if (!result.success) throw new AggregateError(result.logs, `Server build failed: ${target}`)
    if (!options.nativeWindowsTest) await chmod(outfile, 0o755)
  }
  if (!options.nativeWindowsTest) {
    const metadata = validateServerMetadata(options)
    await writeFile(
      path.join(directory, "SERVER_SHA256SUMS"),
      await generateServerChecksums(directory, metadata),
    )
    await writeFile(path.join(directory, "server-build.json"), `${JSON.stringify(metadata, null, 2)}\n`)
  }
}

if (import.meta.main) {
  process.chdir(path.resolve(import.meta.dir, ".."))
  await buildServer(process.argv.slice(2))
}
