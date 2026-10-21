import { createHash } from "node:crypto"
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import pkg from "../packages/cli/package.json" with { type: "json" }
import { type Target, targets, validateBuildMetadata } from "./build-metadata.ts"

export { targets } from "./build-metadata.ts"

export function buildOptions(argv: string[]) {
  let target = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
  let version = pkg.version
  let channel = "stable"
  let all = false
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === "--all") {
      all = true
      continue
    }
    if (flag !== "--target" && flag !== "--version" && flag !== "--channel") {
      throw new Error(`Unknown build option: ${flag}`)
    }
    const value = argv[++i]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`)
    if (flag === "--target") target = value
    if (flag === "--version") version = value
    if (flag === "--channel") channel = value
  }
  if (!targets.includes(target as Target)) throw new Error(`Unsupported target: ${target}`)
  return validateBuildMetadata({ targets: all ? [...targets] : [target], version, channel })
}

async function command(argv: string[], env?: Record<string, string>) {
  const child = Bun.spawn(argv, { stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } })
  if ((await child.exited) !== 0) throw new Error(`Failed: ${argv[0]}`)
}

async function archive(target: Target, executable: string) {
  const base = `amira-${target}`
  const windows = target.startsWith("bun-windows-")
  const output = path.resolve("dist", `${base}.${windows ? "zip" : "tar.gz"}`)
  if (!windows) {
    await command([
      "tar",
      "-czf",
      path.join("dist", `${base}.tar.gz`),
      "-C",
      path.join("dist", base),
      "amira",
    ])
  } else if (process.platform === "win32") {
    await command(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; Compress-Archive -LiteralPath $env:AMIRA_BUILD_EXE -DestinationPath $env:AMIRA_BUILD_ARCHIVE -Force",
      ],
      { AMIRA_BUILD_EXE: path.resolve(executable), AMIRA_BUILD_ARCHIVE: output },
    )
  } else {
    // zip replaces entries in an existing archive; the archive contains only this one filename.
    await command(["zip", "-j", output, executable])
  }
}

async function build(argv: string[]) {
  const options = buildOptions(argv)
  process.chdir(path.resolve(import.meta.dir, ".."))
  await mkdir("dist", { recursive: true })
  // A failed rebuild must not let staging label partially replaced binaries with old metadata.
  await rm("dist/build.json", { force: true })
  for (const target of options.targets) {
    const windows = target.startsWith("bun-windows-")
    const directory = path.join("dist", `amira-${target}`)
    await mkdir(directory, { recursive: true })
    const outfile = path.join(directory, windows ? "amira.exe" : "amira")
    console.log(`Building ${options.version} (${options.channel}, ${target})`)
    const result = await Bun.build({
      entrypoints: ["build/entries/amira.ts", "build/entries/worker.ts", "build/entries/stdout-worker.ts"],
      compile: {
        target,
        outfile,
        assets: ["packages/cli/themes"],
        autoloadDotenv: false,
        autoloadBunfig: false,
        ...(windows
          ? {
              windows: {
                title: "Amira",
                publisher: "CAMB-dev",
                version: options.version.split(/[-+]/)[0],
                description: "Amira terminal coding agent",
              },
            }
          : {}),
      },
      minify: true,
      bytecode: true,
      format: "esm",
      define: {
        AMIRA_VERSION: JSON.stringify(options.version),
        AMIRA_CHANNEL: JSON.stringify(options.channel),
        AMIRA_TARGET: JSON.stringify(target),
        AMIRA_SERVER_BUILD_ID: JSON.stringify(process.env.AMIRA_SERVER_BUILD_ID ?? "development-unverified"),
      },
    })
    if (!result.success) throw new AggregateError(result.logs, `Build failed: ${target}`)
    if (!windows) await chmod(outfile, 0o755)
    await archive(target, outfile)
  }
  const archives = (await readdir("dist"))
    .filter((name) =>
      targets.some(
        (target) => name === `amira-${target}.${target.startsWith("bun-windows-") ? "zip" : "tar.gz"}`,
      ),
    )
    .sort()
  const sums: string[] = []
  for (const name of archives) {
    const digest = createHash("sha256")
      .update(new Uint8Array(await Bun.file(path.join("dist", name)).arrayBuffer()))
      .digest("hex")
    sums.push(`${digest}  ${name}\n`)
  }
  await writeFile("dist/SHA256SUMS", sums.join(""))
  // Consumers must use this build's version/targets, not infer them from the source checkout.
  await writeFile("dist/build.json", `${JSON.stringify(options, null, 2)}\n`)
}

if (import.meta.main) await build(process.argv.slice(2))
