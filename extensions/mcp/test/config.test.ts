// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings test ${VAR} expansion
import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { expand, parseServers, readMcpConfig } from "../src/config.ts"
import { mcpToolName, toToolResult } from "../src/tools.ts"

const tmp = mkdtempSync(path.join(os.tmpdir(), "amira-mcp-config-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

test("reads mcpServers from .mcp.json and both settings files; Amira's settings win", () => {
  const cwd = path.join(tmp, "project")
  const home = path.join(tmp, "home")
  mkdirSync(path.join(cwd, ".amira"), { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(
    path.join(cwd, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        shared: { command: "from-mcp-json" },
        claude: { type: "http", url: "https://example.test/${PATH_PART:-mcp}", headers: { a: "${TOKEN}" } },
        old: { type: "sse", url: "https://example.test/sse" },
      },
    }),
  )
  writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify({
      model: "x",
      mcpServers: { shared: { command: "from-user" }, user: { command: "u", args: ["--flag", "${TOKEN}"] } },
    }),
  )
  writeFileSync(
    path.join(cwd, ".amira", "settings.json"),
    JSON.stringify({
      mcpServers: {
        shared: { command: "from-project", env: { K: "v" }, timeout: 1000 },
        user: { disabled: true },
      },
    }),
  )
  const { servers, problems } = readMcpConfig(cwd, home, { TOKEN: "t0k" })
  expect(problems).toEqual([
    `${path.join(cwd, ".mcp.json")}: MCP server "old": the legacy "sse" transport is not supported; use "http" (streamable HTTP)`,
  ])
  // Disabling in a later file switches off the earlier entry.
  expect(servers.map((s) => s.name).sort()).toEqual(["claude", "shared"])
  expect(servers.find((s) => s.name === "shared")).toEqual({
    name: "shared",
    source: path.join(cwd, ".amira", "settings.json"),
    type: "stdio",
    command: "from-project",
    args: [],
    env: { K: "v" },
    timeoutMs: 1000,
  })
  expect(servers.find((s) => s.name === "claude")).toMatchObject({
    type: "http",
    url: "https://example.test/mcp",
    headers: { a: "t0k" },
  })
  const args = parseServers({ s: { command: "${BIN}", args: ["--t", "${TOKEN}"] } }, "f", {
    BIN: "b",
    TOKEN: "t",
  })
  expect(args.servers[0]).toMatchObject({ command: "b", args: ["--t", "t"] })
})

test("invalid files and entries become problems, not exceptions", () => {
  const cwd = path.join(tmp, "bad")
  mkdirSync(cwd, { recursive: true })
  writeFileSync(path.join(cwd, ".mcp.json"), "{ nope")
  expect(readMcpConfig(cwd, path.join(tmp, "nohome")).problems[0]).toContain("invalid JSON")
  const r = parseServers(
    {
      a: { args: [] },
      b: { command: "x", args: "not-array" },
      c: { type: "http" },
      d: "string",
      e: { type: "weird" },
      f: { command: "x", env: { N: 1 } },
      g: { command: "x", timeout: -1 },
    },
    "file",
  )
  expect(r.servers).toEqual([])
  expect(r.problems.map((p) => p.replace(/^file: MCP server "(\w)": /, "$1: "))).toEqual([
    'a: "command" is required',
    'b: "args" must be an array of strings',
    'c: "url" is required',
    "d: must be an object",
    'e: unknown type "weird"',
    'f: "env" must map names to strings',
    'g: "timeout" must be a positive number of ms',
  ])
  expect(parseServers([], "file").problems).toEqual(['file: "mcpServers" must be an object'])
})

test("expand handles defaults and unset variables", () => {
  expect(expand("${A}-${B:-dflt}-${C}", { A: "1" })).toBe("1-dflt-")
  expect(expand("$A ${A", { A: "1" })).toBe("$A ${A")
})

test("tool names are provider-safe and bounded", () => {
  expect(mcpToolName("my.server", "do thing")).toBe("mcp__my_server__do_thing")
  const long = mcpToolName("server", "x".repeat(100))
  expect(long.length).toBe(64)
  expect(long).toMatch(/^mcp__server__x+_[a-z0-9]+$/)
  expect(mcpToolName("server", `${"x".repeat(100)}y`)).not.toBe(long)
})

test("results map text, images, resources and errors", () => {
  expect(toToolResult({ content: [], isError: true })).toEqual({
    content: [{ type: "text", text: "(no output)" }],
    isError: true,
  })
  expect(
    toToolResult({
      content: [
        { type: "resource", resource: { uri: "u", mimeType: "image/png", blob: "AA==" } },
        { type: "resource", resource: { uri: "v", blob: "AA==" } },
        { type: "unknown" } as never,
      ],
    }),
  ).toEqual({
    content: [
      { type: "image", data: "AA==", mimeType: "image/png" },
      { type: "text", text: "[resource v (binary), not shown]" },
    ],
  })
})
