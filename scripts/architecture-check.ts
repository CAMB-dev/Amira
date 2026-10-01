import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

/**
 * Architecture guard rails for the workspace.
 *
 * The dependency table is intentionally explicit: update it when a package boundary changes.
 * Source files over 900 lines must be added to the allowlist with their current line count. When
 * an allowlisted file is split, remove it from the list so the new files are checked normally.
 */
const root = path.resolve(import.meta.dir, "..")
const importPattern = /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)(["'`])([^"'`]+)\1/g
const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx"])
const packageDependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]
const sourceLineLimit = 900

const allowedDependenciesByDirectory: Record<string, readonly string[]> = {
  "packages/ai": [],
  "packages/net": [],
  "packages/proc": [],
  "packages/text-width": [],
  "packages/tui-kit": ["@amira/text-width"],
  "packages/api": ["@amira/text-width"],
  "packages/core": ["@amira/ai", "@amira/api", "@amira/net", "@amira/proc"],
  "packages/packages": ["@amira/api", "@amira/core", "@amira/proc"],
  "packages/tui": ["@amira/ai", "@amira/api", "@amira/core", "@amira/proc", "@amira/tui-kit"],
  // The CLI is the composition root and may reach every workspace package. It bundles the
  // extensions by source path from its bundling root (D50), never as package dependencies.
  "packages/cli": [
    "@amira/ai",
    "@amira/api",
    "@amira/core",
    "@amira/net",
    "@amira/packages",
    "@amira/proc",
    "@amira/tui",
    "@amira/tui-kit",
  ],
  "extensions/*": ["@amira/api"],
}

const sourceLineAllowlist = new Map<string, number>([
  ["packages/core/src/agent.ts", 2803],
  ["packages/core/src/subagents.ts", 1311],
  ["packages/tui/src/app.ts", 2223],
  ["packages/tui/src/blocks.ts", 1186],
  ["packages/tui/src/transcript-pane.ts", 1100],
  ["packages/tui-kit/src/components/editor.ts", 979],
  ["packages/tui-kit/src/components/form.ts", 962],
])

function filesUnder(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(fullPath))
    else if (sourceExtensions.has(path.extname(entry.name))) files.push(fullPath)
  }
  return files
}

function packageDirectories(parent: string): string[] {
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
    .map((entry) => path.join(parent, entry.name))
    .filter((directory) =>
      statSync(path.join(directory, "package.json"), { throwIfNoEntry: false })?.isFile(),
    )
}

function sourceFilesUnder(directory: string): string[] {
  return filesUnder(directory).filter((file) => path.extname(file) === ".ts")
}

function importsIn(source: string): string[] {
  const typeOnlyRanges = [
    ...source.matchAll(/\b(?:import|export)\s+type\b[\s\S]*?\bfrom\s*(["'`])[^"'`]+\1/g),
  ].map((match) => [match.index ?? 0, (match.index ?? 0) + match[0].length] as const)
  return [...source.matchAll(importPattern)]
    .filter(
      (match) =>
        !typeOnlyRanges.some(([start, end]) => (match.index ?? 0) >= start && (match.index ?? 0) < end),
    )
    .map((match) => match[2] as string)
}

function packageDependencyNames(packageJsonPath: string): Set<string> {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>
  const names = new Set<string>()
  for (const field of packageDependencyFields) {
    const dependencies = packageJson[field]
    if (!dependencies || typeof dependencies !== "object") continue
    for (const name of Object.keys(dependencies)) names.add(name)
  }
  return names
}

function relative(file: string): string {
  return path.relative(root, file).replaceAll(path.sep, "/")
}

/** The repo directory (e.g. "packages/core") a relative specifier in `file` lands in, if any. */
function targetPackage(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined
  const [top, name] = relative(path.resolve(path.dirname(file), specifier)).split("/")
  return (top === "packages" || top === "extensions") && name ? `${top}/${name}` : undefined
}

function lineCount(file: string): number {
  const source = readFileSync(file, "utf8")
  if (!source) return 0
  return source.split(/\r?\n/).length - (source.endsWith("\n") ? 1 : 0)
}

/**
 * The composition root that bundles the built-in extensions (D50). It is the one host file that
 * may reach into extensions/*; everything else talks to them through @amira/api.
 */
const bundlingRoots = new Set(["packages/cli/src/session.ts"])
const packageRoot = path.join(root, "packages")
const extensionRoot = path.join(root, "extensions")
const packageDirectoriesInWorkspace = [
  ...packageDirectories(packageRoot),
  ...packageDirectories(extensionRoot),
]
const extensionPackageNames = new Set<string>()
const packageNamesByDirectory = new Map<string, string>()
for (const directory of packageDirectoriesInWorkspace) {
  const packageJson = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as {
    name: string
  }
  const own = relative(directory)
  packageNamesByDirectory.set(own, packageJson.name)
  if (own.startsWith("extensions/")) extensionPackageNames.add(packageJson.name)
}

function allowedDependencies(own: string): ReadonlySet<string> {
  const allowed = allowedDependenciesByDirectory[own] ?? allowedDependenciesByDirectory["extensions/*"]
  if (!allowed) throw new Error(`Missing architecture table entry for ${own}`)
  return new Set(allowed)
}

const violations: string[] = []

for (const directory of packageDirectoriesInWorkspace) {
  const own = relative(directory)
  const packageJsonPath = path.join(directory, "package.json")
  const declared = packageDependencyNames(packageJsonPath)
  const allowed = allowedDependencies(own)
  const actual = new Set<string>()

  for (const file of filesUnder(path.join(directory, "src"))) {
    for (const specifier of importsIn(readFileSync(file, "utf8"))) {
      if (specifier.startsWith("@amira/")) actual.add(specifier)

      const target = targetPackage(file, specifier)
      if (!target || target === own) continue
      const targetName = packageNamesByDirectory.get(target)
      if (!targetName) continue
      // The composition root intentionally bundles extensions by source path; this is the one
      // relative cross-workspace import that does not need a package dependency declaration.
      if (target.startsWith("extensions/") && bundlingRoots.has(relative(file))) continue
      actual.add(targetName)
    }
  }

  for (const dependency of declared) {
    if (!dependency.startsWith("@amira/")) continue
    if (!allowed.has(dependency)) {
      violations.push(
        `${relative(packageJsonPath)} declares ${dependency}, outside its allowed dependency table`,
      )
    }
    if (!actual.has(dependency)) {
      violations.push(`${relative(packageJsonPath)} declares unused workspace dependency ${dependency}`)
    }
  }

  for (const dependency of actual) {
    if (!dependency.startsWith("@amira/")) continue
    if (!allowed.has(dependency)) {
      violations.push(
        `${relative(directory)}/src imports ${dependency}, outside its allowed dependency table`,
      )
    }
    if (!declared.has(dependency)) {
      violations.push(
        `${relative(directory)}/src imports ${dependency}, but package.json does not declare it`,
      )
    }
  }

  if (own.startsWith("extensions/")) {
    for (const dependency of actual) {
      if (dependency.startsWith("@amira/") && dependency !== "@amira/api") {
        violations.push(
          `${relative(directory)}/src imports ${dependency}; extensions may only import @amira/api`,
        )
      }
    }
    for (const dependency of declared) {
      if (dependency.startsWith("@amira/") && dependency !== "@amira/api") {
        violations.push(
          `${relative(packageJsonPath)} declares ${dependency}; extensions may only depend on @amira/api`,
        )
      }
    }
  }

  if (own.startsWith("packages/")) {
    for (const file of filesUnder(directory)) {
      for (const specifier of importsIn(readFileSync(file, "utf8"))) {
        if (extensionPackageNames.has(specifier)) {
          violations.push(
            `${relative(file)} imports extension package ${specifier}; packages must depend on @amira/api`,
          )
        }
      }
    }
    // Tests may load extensions by path to exercise them inside the host; host source may not.
    for (const file of filesUnder(path.join(directory, "src"))) {
      for (const specifier of importsIn(readFileSync(file, "utf8"))) {
        if (targetPackage(file, specifier)?.startsWith("extensions/") && !bundlingRoots.has(relative(file))) {
          violations.push(`${relative(file)} imports ${specifier}; packages must depend on @amira/api`)
        }
      }
    }
  }

  for (const file of sourceFilesUnder(path.join(directory, "src"))) {
    const key = relative(file)
    const lines = lineCount(file)
    if (lines <= sourceLineLimit) continue
    const cap = sourceLineAllowlist.get(key)
    if (cap === undefined) {
      violations.push(
        `${key} has ${lines} lines; split it or add it to the explicit ${sourceLineLimit}-line allowlist`,
      )
    } else if (lines > cap) {
      violations.push(`${key} grew to ${lines} lines; its allowlist cap is ${cap}`)
    }
  }
}

for (const [key, cap] of sourceLineAllowlist) {
  const file = path.join(root, key)
  try {
    const lines = lineCount(file)
    if (lines <= sourceLineLimit) {
      violations.push(`${key} is no longer oversized; remove it from the source line allowlist`)
    } else if (lines > cap) {
      violations.push(`${key} grew to ${lines} lines; its allowlist cap is ${cap}`)
    }
  } catch {
    violations.push(`${key} is missing; remove it from the source line allowlist`)
  }
}

if (violations.length) {
  console.error("Architecture boundary check failed:")
  for (const violation of [...new Set(violations)].sort()) console.error(`- ${violation}`)
  process.exit(1)
}

console.log("Architecture boundary check passed.")
