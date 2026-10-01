import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const importPattern = /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)(["'`])([^"'`]+)\1/g
const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx"])
const packageDependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]

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

function importsIn(source: string): string[] {
  return [...source.matchAll(importPattern)].map((match) => match[2] as string)
}

function packageDependencyNames(packageJsonPath: string): string[] {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>
  const names: string[] = []
  for (const field of packageDependencyFields) {
    const dependencies = packageJson[field]
    if (!dependencies || typeof dependencies !== "object") continue
    for (const name of Object.keys(dependencies)) names.push(name)
  }
  return names
}

function relative(file: string): string {
  return path.relative(root, file).replaceAll(path.sep, "/")
}

const violations: string[] = []
const extensionDirectories = packageDirectories(path.join(root, "extensions"))
for (const directory of extensionDirectories) {
  for (const file of filesUnder(path.join(directory, "src"))) {
    for (const specifier of importsIn(readFileSync(file, "utf8"))) {
      if (specifier.startsWith("@amira/") && specifier !== "@amira/api") {
        violations.push(`${relative(file)} imports ${specifier}; extensions may only import @amira/api`)
      }
    }
  }
  for (const specifier of packageDependencyNames(path.join(directory, "package.json"))) {
    if (specifier.startsWith("@amira/") && specifier !== "@amira/api") {
      violations.push(
        `${relative(path.join(directory, "package.json"))} declares ${specifier}; extensions may only depend on @amira/api`,
      )
    }
  }
}

const extensionPackageNames = new Set(
  extensionDirectories.map((directory) => {
    const packageJson = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as {
      name: string
    }
    return packageJson.name
  }),
)
for (const directory of packageDirectories(path.join(root, "packages"))) {
  for (const file of filesUnder(directory)) {
    for (const specifier of importsIn(readFileSync(file, "utf8"))) {
      if (extensionPackageNames.has(specifier)) {
        violations.push(
          `${relative(file)} imports extension package ${specifier}; packages must depend on @amira/api`,
        )
      }
    }
  }
  for (const specifier of packageDependencyNames(path.join(directory, "package.json"))) {
    if (extensionPackageNames.has(specifier)) {
      violations.push(
        `${relative(path.join(directory, "package.json"))} declares extension package ${specifier}`,
      )
    }
  }
}

if (violations.length) {
  console.error("Architecture boundary check failed:")
  for (const violation of violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log("Architecture boundary check passed.")
