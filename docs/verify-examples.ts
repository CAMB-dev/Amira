import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { CommandContext } from "../packages/api/src/index.ts"
import { validateSettings } from "../packages/core/src/config/schema.ts"
import { EventBus } from "../packages/core/src/event-bus.ts"
import { ExtensionHost } from "../packages/core/src/extensions.ts"
import { InterceptorRegistry } from "../packages/core/src/interceptors.ts"
import { engineMismatch, readManifest } from "../packages/core/src/packages/manifest.ts"
import { ToolRegistry } from "../packages/core/src/tool-registry.ts"

const root = path.resolve(import.meta.dir, "..")
const exampleDir = mkdtempSync(path.join(os.tmpdir(), "amira-doc-examples-"))
process.env.AMIRA_HOME = exampleDir
for (const name of Object.keys(process.env)) {
  if (name.startsWith("AMIRA_LIVE_")) delete process.env[name]
}
const read = (file: string) => readFileSync(path.join(root, file), "utf8")
const en = read("docs/extensions.md")
const zh = read("docs/zh/extensions.md")
const code = en.match(/```ts\n([\s\S]*?)\n```/)![1]!
assert.equal(zh.match(/```ts\n([\s\S]*?)\n```/)![1], code)
const manifest = en.match(/```json\n([\s\S]*?)\n```/)![1]!

try {
  writeFileSync(path.join(exampleDir, "index.ts"), code)
  writeFileSync(path.join(exampleDir, "amira-package.json"), manifest)
  const parsed = readManifest(exampleDir)
  assert.equal(parsed.name, "hello-extension")
  assert.equal(engineMismatch(parsed), undefined)

  let jsonCount = 0
  let settingsCount = 0
  for (const file of [
    "docs/providers.md",
    "docs/zh/providers.md",
    "docs/extensions.md",
    "docs/zh/extensions.md",
    "docs/keybindings.md",
    "docs/zh/keybindings.md",
  ]) {
    for (const match of read(file).matchAll(/```json\n([\s\S]*?)\n```/g)) {
      const value = JSON.parse(match[1]!)
      jsonCount++
      if (
        Object.hasOwn(value, "providers") ||
        (Object.hasOwn(value, "extensions") && !Array.isArray(value.extensions))
      ) {
        assert.deepEqual(validateSettings(value, file).warnings, [])
        settingsCount++
      }
    }
  }

  const bus = new EventBus()
  const host = new ExtensionHost({
    bus,
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
    cwd: root,
    home: exampleDir,
    settings: { extensions: { "hello-extension": { message: "Configured greeting." } } },
  })
  const entry = path.join(exampleDir, "index.ts")
  assert.equal(await host.loadFile(entry), true)
  assert.equal(host.commands.has("hello"), true)
  assert.equal(host.status.snapshot().length, 0)
  const output: string[] = []
  // The example uses only print; this mock intentionally exposes no model/session controls.
  const ctx = { print: (s: string) => output.push(s) } as CommandContext
  await host.commands.get("hello")!.def.run("", ctx)
  await host.commands.get("hello")!.def.run("", ctx)
  assert.deepEqual(output, ["Configured greeting.", "Configured greeting."])
  assert.equal(host.status.snapshot()[0]!.text, "Hello: 2")
  assert.equal(host.unload(entry), true)
  assert.equal(host.commands.has("hello"), false)
  assert.equal(host.status.snapshot().length, 0)
  assert.equal(await host.loadFile(entry), true)
  assert.equal(host.status.snapshot().length, 0)
  host.unloadAll()
  await bus.flush()
  console.log(
    `PASS: ${jsonCount} JSON blocks parse; ${settingsCount} settings examples accepted without warnings.`,
  )
  console.log("PASS: EN/ZH extension examples identical; manifest and engine accepted.")
  console.log("PASS: configured greeting, command execution, status counter, unload and reload reset.")

  const config = path.join(exampleDir, "tsconfig.json")
  writeFileSync(
    config,
    JSON.stringify({
      extends: path.join(root, "tsconfig.json"),
      compilerOptions: {
        paths: {
          "@amira/api": [path.join(root, "packages/api/src/index.ts")],
          "@amira/ai": [path.join(root, "packages/ai/src/index.ts")],
        },
        typeRoots: [path.join(root, "node_modules/@types")],
      },
      include: [path.join(exampleDir, "index.ts")],
    }),
  )
  const checked = Bun.spawnSync(
    [process.execPath, path.join(root, "node_modules/typescript/bin/tsc"), "-p", config, "--noEmit"],
    { stdout: "pipe", stderr: "pipe" },
  )
  assert.equal(checked.exitCode, 0, checked.stdout.toString() + checked.stderr.toString())
  console.log("PASS: extracted extension example typechecks against this checkout's API (TypeScript).")
} finally {
  rmSync(exampleDir, { recursive: true, force: true })
}
