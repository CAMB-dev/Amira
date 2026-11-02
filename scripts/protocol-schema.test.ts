import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { REMOTE_FRONTEND_OPERATIONS } from "../packages/cli/src/remote/protocol.ts"
import { buildProtocolSchema, renderProtocolSchema, root, schemaFile } from "./gen-protocol-schema.ts"
import { SPAWN_TEST_TIMEOUT_MS, SPAWN_WAIT_TIMEOUT_MS } from "./spawn-test.ts"

const temp = mkdtempSync(path.join(os.tmpdir(), "amira-protocol-schema-"))
afterAll(() => rmSync(temp, { recursive: true, force: true }))
type Node = { [key: string]: any }

test("the committed protocol schema is current; run bun scripts/gen-protocol-schema.ts", () => {
  const committed = readFileSync(path.join(root, schemaFile), "utf8").replace(/\r\n/g, "\n")
  expect(committed).toBe(renderProtocolSchema())
})

test("output is deterministic LF JSON with resolvable local references only", () => {
  const rendered = renderProtocolSchema()
  expect(renderProtocolSchema()).toBe(rendered)
  expect(rendered).not.toContain("\r")
  expect(rendered.endsWith("}\n")).toBe(true)
  const schema = JSON.parse(rendered) as Node
  expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema")
  expect(Object.keys(schema.$defs)).toEqual(Object.keys(schema.$defs).sort())
  const refs = [...rendered.matchAll(/"\$ref": "([^"]+)"/g)].map((match) => match[1]!)
  for (const ref of refs) expect(schema.$defs[ref.replace("#/$defs/", "")], ref).toBeDefined()
  // Every definition is reachable from the frame roots; nothing internal is carried along.
  const used = new Set(refs.map((ref) => ref.replace("#/$defs/", "")))
  expect(Object.keys(schema.$defs).filter((name) => !used.has(name))).toEqual([])
})

test("only the frontend control surface is published", () => {
  const schema = buildProtocolSchema() as Node
  expect(Object.keys(schema["x-operations"])).toEqual([...REMOTE_FRONTEND_OPERATIONS])
  for (const op of REMOTE_FRONTEND_OPERATIONS)
    expect(op).not.toMatch(/^(?:model\.(?:open|stream|compact)$|(?:proxy|files|images|artifacts|uploads)\.)/)
  const text = JSON.stringify(schema)
  for (const internal of [
    "model.frame",
    "model.event",
    "model.open",
    "ModelRequest",
    "uploads.begin",
    "proxy.bind",
  ])
    expect(text).not.toContain(internal)
  expect(schema.$defs.ClientFrame["x-discriminator"]).toBe("kind")
  expect(schema.$defs.SessionInfo.properties.contextWindowSource.description).toContain(
    "context-window-source.provider",
  )
})

/** Code generators need every tagged union branch to be a named type with a single tag value. */
function taggedUnionProblems(schema: Node): string[] {
  const problems: string[] = []
  const tag = (branch: Node, key: string): Node | undefined => {
    const target = branch.$ref ? schema.$defs[(branch.$ref as string).replace("#/$defs/", "")] : branch
    if (target?.anyOf || target?.oneOf) return undefined // A nested union is checked on its own.
    return target?.properties?.[key]
  }
  const walk = (node: unknown, at: string) => {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) {
      for (const [index, item] of node.entries()) walk(item, `${at}/${index}`)
      return
    }
    const record = node as Node
    const key = record["x-discriminator"]
    for (const union of ["oneOf", "anyOf"] as const)
      for (const [index, branch] of (key ? (record[union] ?? []) : []).entries()) {
        if (!branch.$ref) problems.push(`${at}/${union}/${index}: inline branch of a tagged union`)
        const value = tag(branch, key)
        if (value && !("const" in value)) problems.push(`${at}/${union}/${index}: ${key} has several values`)
      }
    for (const [name, child] of Object.entries(record)) walk(child, `${at}/${name}`)
  }
  walk(schema, "#")
  return problems
}

test("tagged unions have only named single-tag branches, and the lint catches regressions", () => {
  const schema = buildProtocolSchema() as Node
  expect(taggedUnionProblems(schema)).toEqual([])
  const inline = { type: "object", properties: { kind: { const: "a" } } }
  const multi = { type: "object", properties: { kind: { enum: ["b", "c"] } } }
  const broken = {
    $defs: {
      ...schema.$defs,
      Multi: multi,
      Bad: { anyOf: [inline, { $ref: "#/$defs/Multi" }], "x-discriminator": "kind" },
    },
  }
  expect(taggedUnionProblems(broken)).toEqual([
    "#/$defs/Bad/anyOf/0: inline branch of a tagged union",
    "#/$defs/Bad/anyOf/1: kind has several values",
  ])
  // Hoisted names a C# or TypeScript generator would emit for the split branches.
  for (const name of [
    "TextDelta",
    "ThinkingDelta",
    "ContentStartStreamEvent",
    "QueuedSteer",
    "DetachEffect",
    "AcceptedUiAck",
    "InvalidUiAck",
    "PauseConversationControl",
    "AssistantContent",
    "ThinkingBlock",
  ])
    expect(schema.$defs[name], name).toBeDefined()
})

test("decode-only documents and known fault codes are published outside the frame unions", () => {
  const schema = buildProtocolSchema() as Node
  expect(schema["x-decode-only"]).toEqual([
    { $ref: "#/$defs/ResponseEnvelope" },
    { $ref: "#/$defs/ServerListOutput" },
  ])
  for (const name of ["ResponseEnvelope", "ServerListOutput"]) {
    expect(schema.$defs[name]["x-decode-only"]).toBe(true)
    expect(JSON.stringify(schema.$defs.ServerFrame)).not.toContain(name)
  }
  expect(schema.$defs.ResponseEnvelope["x-result-by"]).toBe("op")
  const codes = schema.$defs.Fault.properties.code["x-known-codes"]
  for (const code of ["controller_busy", "incompatible_build", "operation_expired", "operation_failed"])
    expect(codes).toContain(code)
  expect(new Set(codes).size).toBe(codes.length)
})

test(
  "--check passes for the current file and fails for a stale one",
  () => {
    const file = path.join(temp, "schema.json")
    const check = () =>
      Bun.spawnSync(
        [process.execPath, path.join(import.meta.dir, "gen-protocol-schema.ts"), "--check", "--out", file],
        {
          stdout: "pipe",
          stderr: "pipe",
          timeout: SPAWN_WAIT_TIMEOUT_MS,
        },
      )
    writeFileSync(file, renderProtocolSchema())
    expect(check().exitCode).toBe(0)
    writeFileSync(file, renderProtocolSchema().replace('"title": "HelloFrame"', '"title": "OldHelloFrame"'))
    const stale = check()
    expect(stale.exitCode).toBe(1)
    expect(stale.stderr.toString()).toContain("is stale")
  },
  SPAWN_TEST_TIMEOUT_MS,
)
