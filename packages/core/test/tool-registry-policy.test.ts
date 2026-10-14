import { expect, test } from "bun:test"
import { defineTool, type ToolDefinition, textResult } from "@amira/api"
import { ToolRegistry } from "../src/tool-registry.ts"

function tool(name: string, options: Partial<ToolDefinition> = {}): ToolDefinition {
  return defineTool({
    name,
    description: `The ${name} tool`,
    parameters: { type: "object" },
    execute: async () => textResult("ok"),
    ...options,
  })
}

function expectHidden(registry: ToolRegistry, definition: ToolDefinition, source: string): void {
  expect(registry.isEnabled(definition)).toBe(false)
  expect(registry.has(definition.name)).toBe(true)
  expect(registry.get(definition.name)).toBeUndefined()
  expect(registry.getRegistration(definition.name)).toBeUndefined()
  expect(registry.active()).not.toContain(definition)
  expect(registry.deferred()).not.toContain(definition)
  expect(registry.all().map(({ tool }) => tool)).not.toContain(definition)
  expect(registry.list().find(({ tool }) => tool.name === definition.name)).toEqual({
    tool: definition,
    source,
    disabled: true,
  })
}

function expectVisible(registry: ToolRegistry, definition: ToolDefinition, source: string): void {
  expect(registry.isEnabled(definition)).toBe(true)
  expect(registry.get(definition.name)).toBe(definition)
  expect(registry.getRegistration(definition.name)).toMatchObject({ tool: definition, source })
  expect(registry.all()).toContainEqual({ tool: definition, source })
  expect(registry.list()).toContainEqual({ tool: definition, source, disabled: false })
}

test.each(["active", "deferred"] as const)(
  "%s shell and interactive definitions cannot bypass host policy in root or private nested views",
  (exposure) => {
    const root = new ToolRegistry()
    const rootShell = tool("root_shell", { exposure, traits: { shell: "powershell" } })
    const rootInteractive = tool("root_interactive", { exposure, traits: { interactive: true } })
    root.register(rootShell, "ext:root")
    root.register(rootInteractive, "ext:root")
    const privateShell = tool("private_shell", { exposure, traits: { shell: "powershell" } })
    const privateInteractive = tool("private_interactive", { exposure, traits: { interactive: true } })
    const view = ToolRegistry.view(root, () => true, [privateShell, privateInteractive])
    const nestedShell = tool("nested_shell", { exposure, traits: { shell: "powershell" } })
    const nestedInteractive = tool("nested_interactive", { exposure, traits: { interactive: true } })
    const nested = ToolRegistry.view(view, () => true, [nestedShell, nestedInteractive])
    root.setPolicy({ shell: "bash", nonInteractive: true })

    for (const registry of [root, view, nested]) {
      expectHidden(registry, rootShell, "ext:root")
      expectHidden(registry, rootInteractive, "ext:root")
      expect(registry.active()).toEqual([])
      expect(registry.deferred()).toEqual([])
      expect(registry.all()).toEqual([])
    }
    for (const registry of [view, nested]) {
      expectHidden(registry, privateShell, "core")
      expectHidden(registry, privateInteractive, "core")
    }
    expectHidden(nested, nestedShell, "core")
    expectHidden(nested, nestedInteractive, "core")
  },
)

test.each(["shell", "interactive"] as const)(
  "a forbidden private %s override hides an allowed base definition without fallback",
  (capability) => {
    const root = new ToolRegistry()
    const base = tool("shared")
    root.register(base, "ext:base")
    const privateOverride = tool("shared", {
      traits: capability === "shell" ? { shell: "powershell" } : { interactive: true },
    })
    const view = ToolRegistry.view(root, () => true, [privateOverride])
    const nested = ToolRegistry.view(view, () => true)
    root.setPolicy({ shell: "bash", nonInteractive: true })

    expectVisible(root, base, "ext:base")
    for (const registry of [view, nested]) {
      expectHidden(registry, privateOverride, "core")
      expect(registry.active()).toEqual([])
      expect(registry.deferred()).toEqual([])
      expect(registry.all()).toEqual([])
      expect(registry.list()).toEqual([{ tool: privateOverride, source: "core", disabled: true }])
    }
  },
)

test.each(["shell", "interactive"] as const)(
  "an allowed private definition does not inherit a same-name base %s denial",
  (capability) => {
    const root = new ToolRegistry()
    const base = tool("shared", {
      traits: capability === "shell" ? { shell: "powershell" } : { interactive: true },
    })
    root.register(base, "ext:base")
    const privateOverride = tool("shared", { exposure: "deferred" })
    const view = ToolRegistry.view(root, () => true, [privateOverride])
    const nested = ToolRegistry.view(view, () => true)
    const forbiddenPrivate = tool("shared", { traits: base.traits })
    const blockedView = ToolRegistry.view(root, () => true, [forbiddenPrivate])
    const nestedOverride = ToolRegistry.view(blockedView, () => true, [privateOverride])
    root.setPolicy({ shell: "bash", nonInteractive: true })

    expectHidden(root, base, "ext:base")
    expectHidden(blockedView, forbiddenPrivate, "core")
    for (const registry of [view, nested, nestedOverride]) {
      expectVisible(registry, privateOverride, "core")
      expect(registry.active()).toEqual([])
      expect(registry.deferred()).toEqual([privateOverride])
      expect(registry.all()).toEqual([{ tool: privateOverride, source: "core" }])
      expect(registry.list()).toEqual([{ tool: privateOverride, source: "core", disabled: false }])
    }

    root.setDisabled(["shared"])
    for (const registry of [view, nested, nestedOverride]) {
      expectHidden(registry, privateOverride, "core")
    }
    root.setDisabled([])
    expectVisible(nested, privateOverride, "core")
    expectVisible(nestedOverride, privateOverride, "core")
  },
)

test.each(["shell", "interactive"] as const)(
  "the latest forbidden global %s override never falls back to an allowed registration",
  (capability) => {
    const root = new ToolRegistry()
    const base = tool("shared")
    root.register(base, "ext:base")
    const view = ToolRegistry.view(root, () => true)
    const nested = ToolRegistry.view(view, () => true)
    root.setPolicy({ shell: "bash", nonInteractive: true })
    const override = tool("shared", {
      override: true,
      exposure: "deferred",
      traits: capability === "shell" ? { shell: "powershell" } : { interactive: true },
    })
    const remove = nested.register(override, "ext:override")

    for (const registry of [root, view, nested]) {
      expectHidden(registry, override, "ext:override")
      expect(registry.active()).toEqual([])
      expect(registry.deferred()).toEqual([])
      expect(registry.all()).toEqual([])
      expect(registry.list()).toEqual([{ tool: override, source: "ext:override", disabled: true }])
    }
    remove()
    for (const registry of [root, view, nested]) {
      expectVisible(registry, base, "ext:base")
      expect(registry.active()).toEqual([base])
      expect(registry.deferred()).toEqual([])
    }
  },
)

test("partial live policy updates reach existing views without resetting other policy fields", () => {
  const root = new ToolRegistry()
  const bash = tool("private_bash", { traits: { shell: "bash" } })
  const powershell = tool("private_powershell", { exposure: "deferred", traits: { shell: "powershell" } })
  const interactive = tool("private_interactive", { traits: { interactive: true } })
  const view = ToolRegistry.view(root, () => true, [bash, powershell, interactive])
  const nested = ToolRegistry.view(view, () => true)
  expect(view.active()).toEqual([bash, interactive])
  expect(nested.deferred()).toEqual([powershell])

  root.setPolicy({ shell: "bash" })
  for (const registry of [view, nested]) {
    expect(registry.active()).toEqual([bash, interactive])
    expectHidden(registry, powershell, "core")
  }
  root.setPolicy({ nonInteractive: true })
  for (const registry of [view, nested]) {
    expect(registry.active()).toEqual([bash])
    expectHidden(registry, powershell, "core")
    expectHidden(registry, interactive, "core")
  }
  root.setPolicy({ shell: "powershell" })
  for (const registry of [view, nested]) {
    expect(registry.active()).toEqual([])
    expect(registry.deferred()).toEqual([powershell])
    expectHidden(registry, bash, "core")
    expectHidden(registry, interactive, "core")
  }
  root.setPolicy({ nonInteractive: false })
  for (const registry of [view, nested]) {
    expect(registry.active()).toEqual([interactive])
    expectHidden(registry, bash, "core")
    expectVisible(registry, powershell, "core")
  }
  root.setPolicy({ shell: "auto" })
  for (const registry of [view, nested]) {
    expect(registry.active()).toEqual([bash, interactive])
    expect(registry.deferred()).toEqual([powershell])
    expectVisible(registry, bash, "core")
  }
})

test("late registrations through nested views and late private views obey the current host policy", () => {
  const root = new ToolRegistry()
  const view = ToolRegistry.view(root, () => true)
  const nested = ToolRegistry.view(view, () => true)
  root.setPolicy({ shell: "bash", nonInteractive: true })
  const shell = tool("late_shell", { traits: { shell: "powershell" } })
  const interactive = tool("late_interactive", { exposure: "deferred", traits: { interactive: true } })
  const allowed = tool("late_allowed", { traits: { shell: "bash" } })
  root.register(shell, "ext:late")
  nested.register(interactive, "ext:late")
  nested.register(allowed, "ext:late")

  for (const registry of [root, view, nested]) {
    expectHidden(registry, shell, "ext:late")
    expectHidden(registry, interactive, "ext:late")
    expectVisible(registry, allowed, "ext:late")
    expect(registry.active()).toEqual([allowed])
    expect(registry.deferred()).toEqual([])
  }
  const privateShell = tool("late_private_shell", { traits: { shell: "powershell" } })
  const lateView = ToolRegistry.view(nested, () => true, [privateShell])
  expectHidden(lateView, privateShell, "core")
  root.setPolicy({ shell: "auto", nonInteractive: false })
  expectVisible(lateView, privateShell, "core")
  expectVisible(lateView, shell, "ext:late")
  expectVisible(lateView, interactive, "ext:late")
  expect(lateView.deferred()).toEqual([interactive])
})

test("built-in name floors deny ask_user even when a private override declares interactive false", () => {
  const root = new ToolRegistry()
  const base = tool("ask_user", { traits: { interactive: false } })
  root.register(base, "ext:base")
  const privateOverride = tool("ask_user", { exposure: "deferred", traits: { interactive: false } })
  const view = ToolRegistry.view(root, () => true, [privateOverride])
  const nested = ToolRegistry.view(view, () => true)
  root.setPolicy({ nonInteractive: true, enabled: new Set(["ask_user"]) })

  expectHidden(root, base, "ext:base")
  for (const registry of [view, nested]) expectHidden(registry, privateOverride, "core")
  root.setPolicy({ nonInteractive: false })
  expectVisible(root, base, "ext:base")
  expectVisible(nested, privateOverride, "core")
})

test("built-in shell names retain their shell floor when declarations claim the other shell", () => {
  const root = new ToolRegistry()
  const bash = tool("bash", { traits: { shell: "powershell" } })
  const powershell = tool("powershell", { traits: { shell: "bash" } })
  root.register(bash, "ext:shells")
  const view = ToolRegistry.view(root, () => true, [powershell])
  const nested = ToolRegistry.view(view, () => true)
  root.setPolicy({ shell: "bash" })
  expectVisible(nested, bash, "ext:shells")
  expectHidden(nested, powershell, "core")
  expect(nested.active()).toEqual([bash])
  root.setPolicy({ shell: "powershell" })
  expectHidden(nested, bash, "ext:shells")
  expectVisible(nested, powershell, "core")
  expect(nested.active()).toEqual([powershell])
})

test.each(["bash", "powershell"] as const)(
  "shellKind-only unknown tools fail closed under %s selection and become usable under auto",
  (shell) => {
    const root = new ToolRegistry()
    const base = tool("runtime_shell", { shellKind: async () => shell })
    root.register(base, "ext:runtime")
    const privateShell = tool("private_runtime_shell", { exposure: "deferred", shellKind: () => shell })
    const view = ToolRegistry.view(root, () => true, [privateShell])
    const nested = ToolRegistry.view(view, () => true)
    root.setPolicy({ shell })

    expectHidden(root, base, "ext:runtime")
    expectHidden(nested, base, "ext:runtime")
    expectHidden(nested, privateShell, "core")
    expect(nested.active()).toEqual([])
    expect(nested.deferred()).toEqual([])
    root.setPolicy({ shell: "auto" })
    expectVisible(nested, base, "ext:runtime")
    expectVisible(nested, privateShell, "core")
    expect(nested.active()).toEqual([base])
    expect(nested.deferred()).toEqual([privateShell])
  },
)

test.each(["active", "deferred"] as const)(
  "manual shell exceptions authorize the global %s definition, not a private same-name replacement",
  (exposure) => {
    const root = new ToolRegistry()
    const base = tool("selected", { traits: { shell: "powershell" } })
    root.register(base, "ext:base")
    const privateShell = tool("selected", { exposure, traits: { shell: "powershell" } })
    const view = ToolRegistry.view(root, () => true, [privateShell])
    const nested = ToolRegistry.view(view, () => true)
    const interactiveShell = tool("selected", {
      exposure,
      traits: { shell: "powershell", interactive: true },
    })
    const interactiveView = ToolRegistry.view(view, () => true, [interactiveShell])
    root.setPolicy({ shell: "bash", nonInteractive: true })
    expectHidden(root, base, "ext:base")
    expectHidden(nested, privateShell, "core")

    root.setPolicy({ enabled: new Set(["selected"]) })
    expectVisible(root, base, "ext:base")
    for (const registry of [view, nested]) {
      expectHidden(registry, privateShell, "core")
      expect(registry.active()).toEqual([])
      expect(registry.deferred()).toEqual([])
    }
    expectHidden(interactiveView, interactiveShell, "core")
    expect(interactiveView.all()).toEqual([])

    root.setDisabled(["selected"])
    expectHidden(root, base, "ext:base")
    for (const registry of [view, nested]) expectHidden(registry, privateShell, "core")
    expectHidden(interactiveView, interactiveShell, "core")
    root.setPolicy({ shell: "auto", nonInteractive: false })
    expectHidden(nested, privateShell, "core")
    expectHidden(interactiveView, interactiveShell, "core")
    nested.setDisabled([])
    expectVisible(nested, privateShell, "core")
    expectVisible(interactiveView, interactiveShell, "core")

    root.setPolicy({ shell: "bash", nonInteractive: true })
    expectVisible(root, base, "ext:base")
    expectHidden(nested, privateShell, "core")
    expectHidden(interactiveView, interactiveShell, "core")
    root.setPolicy({ enabled: new Set() })
    expectHidden(nested, privateShell, "core")
    expectHidden(root, base, "ext:base")
  },
)

test("enabled names are shell exceptions rather than an allowlist and can be replaced live", () => {
  const root = new ToolRegistry()
  const first = tool("first", { traits: { shell: "powershell" } })
  const second = tool("second", { traits: { shell: "powershell" } })
  const ordinary = tool("ordinary")
  root.register(first, "ext:tools")
  root.register(second, "ext:tools")
  root.register(ordinary, "ext:tools")
  const nested = ToolRegistry.view(
    ToolRegistry.view(root, () => true),
    () => true,
  )
  root.setPolicy({ shell: "bash", enabled: new Set(["first"]) })
  expect(nested.active()).toEqual([first, ordinary])
  expectHidden(nested, second, "ext:tools")
  root.setPolicy({ nonInteractive: true })
  expectVisible(nested, first, "ext:tools")
  expectHidden(nested, second, "ext:tools")
  root.setPolicy({ enabled: new Set(["second"]) })
  expectHidden(nested, first, "ext:tools")
  expectVisible(nested, second, "ext:tools")
  expectVisible(nested, ordinary, "ext:tools")
  expect(nested.active()).toEqual([second, ordinary])
})
