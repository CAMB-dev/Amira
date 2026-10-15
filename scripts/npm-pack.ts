import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import { npmPlatforms as npmTargets } from "../packages/cli/src/npm-platforms.ts"
import { validateBuildMetadata } from "./build-metadata.ts"

export { npmTargets }

type StageOptions = {
  /** Repository root, used for legal files. Defaults to this script's repository. */
  root?: string
  /** Build output containing build.json and amira-bun-* directories. */
  dist?: string
  /** Build target names. Omit to require all five npm platforms. */
  targets?: readonly string[]
}

export function npmPackOptions(argv: string[]) {
  const targets: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--target") throw new Error(`Unknown npm staging option: ${argv[i]}`)
    const target = argv[++i]
    if (!target || target.startsWith("--")) throw new Error("Missing value for --target")
    if (!npmTargets.some((platform) => platform.target === target)) {
      throw new Error(`Unsupported npm target: ${target}`)
    }
    targets.push(target)
  }
  return targets.length ? { targets } : {}
}

/** Stage local publishable directories only; never contacts npm or publishes packages. */
export async function stageNpmPackages(options: StageOptions = {}) {
  const root = path.resolve(options.root ?? path.join(import.meta.dir, ".."))
  const dist = path.resolve(options.dist ?? path.join(root, "dist"))
  const { version, channel, targets } = validateBuildMetadata(
    JSON.parse(await readFile(path.join(dist, "build.json"), "utf8")),
  )
  const requested = options.targets ?? npmTargets.map((platform) => platform.target)
  if (!requested.length) throw new Error("Select at least one npm target")
  for (const target of requested) {
    if (!npmTargets.some((platform) => platform.target === target)) {
      throw new Error(`Unsupported npm target: ${target}`)
    }
  }
  const selected = npmTargets.filter((platform) => requested.includes(platform.target))
  // Preflight everything before replacing previously staged packages. Metadata prevents using stale binaries.
  const binaries = new Map<string, string>()
  for (const platform of selected) {
    if (!targets.includes(platform.target))
      throw new Error(`Build metadata is missing target: ${platform.target}`)
    const binary = path.join(
      dist,
      `amira-${platform.target}`,
      platform.os === "win32" ? "amira.exe" : "amira",
    )
    if (!(await stat(binary)).isFile()) throw new Error(`Missing build executable: ${binary}`)
    binaries.set(platform.target, binary)
  }
  const license = await readFile(path.join(root, "LICENSE"), "utf8")
  let notice: string | undefined
  try {
    notice = await readFile(path.join(root, "NOTICE"), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const template = await readFile(path.join(import.meta.dir, "npm", "amira.js"), "utf8")
  const marker = "/* AMIRA_NPM_PLATFORMS */ []"
  if (!template.includes(marker)) throw new Error("Launcher is missing the platform table marker")
  const launcher = template.replace(marker, JSON.stringify(npmTargets))
  const directory = path.join(dist, "npm")
  // Only this generated subtree is replaced; source files and build artifacts are untouched.
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  const packages: { name: string; directory: string; target?: string }[] = []
  const legalFiles = notice === undefined ? ["LICENSE", "README.md"] : ["LICENSE", "NOTICE", "README.md"]
  async function stage(name: string, manifest: Record<string, unknown>, readme: string, target?: string) {
    const folder = path.join(directory, name)
    await mkdir(path.join(folder, "bin"), { recursive: true })
    await writeFile(
      path.join(folder, "package.json"),
      `${JSON.stringify(
        {
          name,
          version,
          license: "Apache-2.0",
          repository: { type: "git", url: "git+https://github.com/CAMB-dev/Amira.git" },
          homepage: "https://github.com/CAMB-dev/Amira#readme",
          type: "commonjs",
          ...manifest,
        },
        null,
        2,
      )}\n`,
    )
    await writeFile(path.join(folder, "LICENSE"), license)
    if (notice !== undefined) await writeFile(path.join(folder, "NOTICE"), notice)
    await writeFile(path.join(folder, "README.md"), readme)
    packages.push({ name, directory: folder, ...(target ? { target } : {}) })
    return folder
  }
  const main = await stage(
    "amira",
    {
      description: "Amira terminal coding agent",
      bin: { amira: "bin/amira.js" },
      engines: { node: ">=18" },
      files: ["bin/amira.js", ...legalFiles],
      optionalDependencies: Object.fromEntries(npmTargets.map((platform) => [platform.name, version])),
    },
    "# Amira\n\nAmira terminal coding agent. Requires Node.js 18 or later, or Bun.\n\nInstall with `npm install -g amira`. Platform binaries are installed as optional dependencies.\nSet `AMIRA_BINARY` to use an existing executable.\n\n[Source and releases](https://github.com/CAMB-dev/Amira)\n",
  )
  await writeFile(path.join(main, "bin", "amira.js"), launcher)
  await chmod(path.join(main, "bin", "amira.js"), 0o755)
  for (const platform of selected) {
    const executable = platform.os === "win32" ? "amira.exe" : "amira"
    const folder = await stage(
      platform.name,
      {
        description: `Amira executable for ${platform.os} ${platform.cpu}`,
        os: [platform.os],
        cpu: [platform.cpu],
        ...(platform.os === "linux" ? { libc: ["glibc"] } : {}),
        files: [`bin/${executable}`, ...legalFiles],
      },
      `# ${platform.name}\n\nPlatform executable for [Amira](https://github.com/CAMB-dev/Amira).\nInstall the \`amira\` package instead of installing this package directly.\n`,
      platform.target,
    )
    const output = path.join(folder, "bin", executable)
    await copyFile(binaries.get(platform.target)!, output)
    await chmod(output, 0o755)
  }
  return { version, channel, directory, packages }
}

if (import.meta.main) {
  const result = await stageNpmPackages(npmPackOptions(process.argv.slice(2)))
  console.log(
    `Staged ${result.packages.length} npm packages for ${result.version} (${result.channel}) in ${result.directory}`,
  )
}
