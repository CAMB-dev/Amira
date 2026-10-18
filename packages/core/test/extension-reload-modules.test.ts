import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

function writeVersion(dir: string, version: string, exportName: string) {
  writeFileSync(join(dir, "src", "view.ts"), `export const ${exportName} = ${JSON.stringify(version)}\n`)
  writeFileSync(
    join(dir, "src", "index.ts"),
    [
      `import { ${exportName} } from "./view.ts"`,
      "export default (api) => {",
      `  api.registerTool({ name: "reload_probe", description: ${exportName},`,
      '    parameters: { type: "object" }, execute: async () => ({ content: [] }) })',
      "}",
    ].join("\n"),
  )
}

test("reloading a package picks up updated files its entry imports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amira-reload-modules-"))
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus: new EventBus(), interceptors: new InterceptorRegistry(), tools })
  try {
    mkdirSync(join(dir, "src"))
    const entry = join(dir, "src", "index.ts")
    writeVersion(dir, "old", "OLD_KIND")
    expect(await host.loadFile(entry, { source: "probe", name: "probe", root: dir })).toBe(true)
    expect(tools.getRegistration("reload_probe")?.tool.description).toBe("old")
    host.unload("probe")

    // An update renames an export the entry imports: the stale cached file would lack it.
    writeVersion(dir, "new", "NEW_KIND")
    expect(await host.loadFile(entry, { source: "probe", name: "probe", root: dir })).toBe(true)
    expect(tools.getRegistration("reload_probe")?.tool.description).toBe("new")
  } finally {
    host.unloadAll()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a package's entries share its modules within one load, also on reload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amira-reload-shared-"))
  const tools = new ToolRegistry()
  const host = new ExtensionHost({ bus: new EventBus(), interceptors: new InterceptorRegistry(), tools })
  const g = globalThis as { __reloadSharedEvaluations?: number }
  g.__reloadSharedEvaluations = 0
  try {
    mkdirSync(join(dir, "src"))
    writeFileSync(
      join(dir, "src", "shared.ts"),
      "const g = globalThis as { __reloadSharedEvaluations?: number }\ng.__reloadSharedEvaluations = (g.__reloadSharedEvaluations ?? 0) + 1\nexport const state = {}\n",
    )
    for (const name of ["a", "b"]) {
      writeFileSync(join(dir, "src", `${name}.ts`), 'import "./shared.ts"\nexport default () => {}\n')
    }
    const load = async () => {
      for (const name of ["a", "b"]) {
        const entry = join(dir, "src", `${name}.ts`)
        expect(await host.loadFile(entry, { source: `pkg/${name}`, name: "pkg", root: dir })).toBe(true)
      }
    }
    await load()
    expect(g.__reloadSharedEvaluations).toBe(1)
    host.unloadAll()
    await load()
    expect(g.__reloadSharedEvaluations).toBe(2)
  } finally {
    host.unloadAll()
    delete g.__reloadSharedEvaluations
    rmSync(dir, { recursive: true, force: true })
  }
})
