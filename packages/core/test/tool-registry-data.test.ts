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

test("registrations clone and freeze owner metadata without copying the tool definition", () => {
  const tools = new ToolRegistry()
  const definition = tool("owned", { override: true })
  const owner = { home: "/home/amira", dataDir: "/home/amira/extension-data/first" }
  const removeFirst = tools.register(definition, "ext:first", owner)
  const first = tools.getRegistration("owned")!
  expect(first.tool).toBe(definition)
  expect(first.source).toBe("ext:first")
  expect(first.dataOwner).toEqual(owner)
  expect(first.dataOwner).not.toBe(owner)
  expect(Object.isFrozen(first.dataOwner)).toBe(true)
  expect(Object.isFrozen(first)).toBe(true)
  expect(tools.all()).toEqual([{ tool: definition, source: "ext:first" }])
  expect(tools.list()).toEqual([{ tool: definition, source: "ext:first", disabled: false }])

  owner.home = "/changed-home"
  owner.dataDir = "/changed-data"
  expect(first.dataOwner).toEqual({
    home: "/home/amira",
    dataDir: "/home/amira/extension-data/first",
  })
  const removeSecond = tools.register(definition, "ext:second", owner)
  const second = tools.getRegistration("owned")!
  expect(second.tool).toBe(definition)
  expect(second.dataOwner).toEqual(owner)
  expect(second.dataOwner).not.toBe(owner)
  expect(second.dataOwner).not.toBe(first.dataOwner)
  expect(Object.isFrozen(second.dataOwner)).toBe(true)
  removeSecond()
  expect(tools.getRegistration("owned")?.dataOwner).toEqual(first.dataOwner)
  removeFirst()
  expect(tools.getRegistration("owned")).toBeUndefined()
})

test("disposing overrides pairs each owner with its registration even for the same definition and source", () => {
  const tools = new ToolRegistry()
  const definition = tool("shared", { override: true })
  const owners = ["first", "middle", "last"].map((name) => ({
    home: "/home/amira",
    dataDir: `/home/amira/extension-data/${name}`,
  }))
  const disposers = owners.map((owner) => tools.register(definition, "ext:shared", owner))
  expect(tools.get("shared")).toBe(definition)
  expect(tools.getRegistration("shared")?.dataOwner).toEqual(owners[2])
  disposers[1]!()
  expect(tools.getRegistration("shared")?.dataOwner).toEqual(owners[2])
  disposers[2]!()
  expect(tools.get("shared")).toBe(definition)
  expect(tools.getRegistration("shared")?.dataOwner).toEqual(owners[0])
  disposers[1]!()
  disposers[2]!()
  expect(tools.getRegistration("shared")?.dataOwner).toEqual(owners[0])
  disposers[0]!()
  expect(tools.get("shared")).toBeUndefined()
  expect(tools.getRegistration("shared")).toBeUndefined()
})

test("core registrations discard supplied owners and restore extension ownership after disposal", () => {
  const tools = new ToolRegistry()
  const definition = tool("shared", { override: true })
  const owner = { home: "/home/amira", dataDir: "/home/amira/extension-data/extension" }
  tools.register(definition, "ext:shared", owner)
  const removeCore = tools.register(definition, "core", owner)
  expect(tools.getRegistration("shared")?.tool).toBe(definition)
  expect(tools.getRegistration("shared")?.source).toBe("core")
  expect(tools.getRegistration("shared")?.dataOwner).toBeUndefined()
  removeCore()
  expect(tools.getRegistration("shared")?.source).toBe("ext:shared")
  expect(tools.getRegistration("shared")?.dataOwner).toEqual(owner)
  tools.register(tool("unowned"), "ext:legacy")
  expect(tools.getRegistration("unowned")?.dataOwner).toBeUndefined()
  expect(tools.getRegistration("missing")).toBeUndefined()
})

test("deferred tools expose ownership before loading, while disabled tools hide registrations", () => {
  const tools = new ToolRegistry()
  const owner = { home: "/home/amira", dataDir: "/home/amira/extension-data/deferred" }
  const active = tool("active")
  const deferred = tool("deferred", { exposure: "deferred" })
  tools.register(active, "ext:tools", owner)
  tools.register(deferred, "ext:tools", owner)
  expect(tools.active()).toEqual([active])
  expect(tools.deferred()).toEqual([deferred])
  expect(tools.get("deferred")).toBe(deferred)
  expect(tools.getRegistration("deferred")).toEqual({
    tool: deferred,
    source: "ext:tools",
    dataOwner: owner,
  })
  tools.setDisabled(["active", "deferred"])
  for (const name of ["active", "deferred"]) {
    expect(tools.has(name)).toBe(true)
    expect(tools.get(name)).toBeUndefined()
    expect(tools.getRegistration(name)).toBeUndefined()
  }
  expect(tools.active()).toEqual([])
  expect(tools.deferred()).toEqual([])
  tools.setDisabled([])
  expect(tools.getRegistration("active")?.dataOwner).toEqual(owner)
  expect(tools.getRegistration("deferred")?.dataOwner).toEqual(owner)
})

test("nested filtered views preserve owners and hide registrations exactly like tool lookup", () => {
  const tools = new ToolRegistry()
  const owner = { home: "/home/amira", dataDir: "/home/amira/extension-data/views" }
  const visible = tool("visible", { exposure: "deferred" })
  tools.register(visible, "ext:views", owner)
  tools.register(tool("blocked-inner"), "ext:views", owner)
  tools.register(tool("blocked-outer"), "ext:views", owner)
  const inner = ToolRegistry.view(tools, (name) => name !== "blocked-inner")
  const outer = ToolRegistry.view(inner, (name) => name !== "blocked-outer")
  expect(outer.get("visible")).toBe(visible)
  expect(outer.getRegistration("visible")).toEqual({ tool: visible, source: "ext:views", dataOwner: owner })
  expect(outer.deferred()).toEqual([visible])
  for (const name of ["blocked-inner", "blocked-outer", "missing"]) {
    expect(outer.get(name)).toBeUndefined()
    expect(outer.getRegistration(name)).toBeUndefined()
  }

  const throughView = tool("through-view")
  const remove = outer.register(throughView, "ext:nested", owner)
  for (const registry of [tools, inner, outer]) {
    expect(registry.get("through-view")).toBe(throughView)
    expect(registry.getRegistration("through-view")).toEqual({
      tool: throughView,
      source: "ext:nested",
      dataOwner: owner,
    })
    expect(Object.isFrozen(registry.getRegistration("through-view")?.dataOwner)).toBe(true)
  }
  outer.setDisabled(["visible", "through-view"])
  for (const registry of [tools, inner, outer]) {
    expect(registry.get("visible")).toBeUndefined()
    expect(registry.getRegistration("visible")).toBeUndefined()
    expect(registry.getRegistration("through-view")).toBeUndefined()
  }
  outer.setDisabled([])
  expect(outer.getRegistration("visible")?.dataOwner).toEqual(owner)
  remove()
  expect(tools.getRegistration("through-view")).toBeUndefined()
  expect(outer.getRegistration("through-view")).toBeUndefined()
})

test("view-local tools are unowned core tools even when shadowing an extension-owned tool", () => {
  const tools = new ToolRegistry()
  const owner = { home: "/home/amira", dataDir: "/home/amira/extension-data/base" }
  const base = tool("return_result")
  tools.register(base, "ext:base", owner)
  const own = tool("return_result")
  const inner = ToolRegistry.view(tools, () => false, [own])
  const outer = ToolRegistry.view(inner, () => true)
  for (const registry of [inner, outer]) {
    expect(registry.get("return_result")).toBe(own)
    expect(registry.getRegistration("return_result")?.tool).toBe(own)
    expect(registry.getRegistration("return_result")?.source).toBe("core")
    expect(registry.getRegistration("return_result")?.dataOwner).toBeUndefined()
  }
  expect(tools.getRegistration("return_result")?.tool).toBe(base)
  expect(tools.getRegistration("return_result")?.dataOwner).toEqual(owner)
  outer.register(tool("view-core"), "core", owner)
  expect(tools.getRegistration("view-core")?.source).toBe("core")
  expect(tools.getRegistration("view-core")?.dataOwner).toBeUndefined()
})
