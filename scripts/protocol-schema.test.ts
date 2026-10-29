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
