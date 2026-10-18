import "./offline.ts"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import commands from "../../../../extensions/commands/src/index.ts"
import { createCommandHost } from "../../src/control.ts"
import { createWorkspaceRuntime, type ServerEvent } from "../../src/server/runtime.ts"
import { createSession } from "../../src/session.ts"

const reviewUrl = "https://user:URL_PASSWORD@never.invalid/?key=URL_KEY"
const mockAi = (baseUrl: string) =>
  createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl, apiKey: "MOCK_KEY_SENTINEL" }],
  })
const root = () => mkdtempSync(path.join(os.tmpdir(), "amira-status-security-"))
const remove = (cwd: string) => rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })

function assertSafe(output: unknown, events: readonly (AnyEvent | ServerEvent)[], secrets: string[]) {
  expect(events.some((event) => event.type === "command.output")).toBe(true)
  for (const serialized of [JSON.stringify(output), JSON.stringify(events)]) {
    for (const secret of secrets) expect(serialized).not.toContain(secret)
    expect(serialized.toLowerCase()).toContain("https://never.invalid")
  }
}

test.each([
  reviewUrl,
  "https://user:URL_PASSWORD@never.invalid/v1?key=URL_KEY&region=west",
  "HTTPS://user:URL_PASSWORD@NeVeR.InVaLiD:443/path?key=URL_KEY&region=west",
])(
  "server /status projects provider origins without URL userinfo or query credentials in output/events: %s",
  async (baseUrl) => {
    const cwd = root()
    const runtime = await createWorkspaceRuntime({
      cwd,
      ai: mockAi(baseUrl),
      model: "mock/test",
      autoTitle: false,
    })
    const attachment = runtime.attach()
    const events: ServerEvent[] = []
    const off = attachment.subscribeEvents((event) => {
      events.push(event)
    })
    try {
      const result = await attachment.execute("command.run", { line: "/status" })
      expect(result.ok).toBe(true)
      assertSafe(result, events, ["URL_PASSWORD", "URL_KEY", "MOCK_KEY_SENTINEL", "user:", "?key="])
      expect(result.output.join("\n")).toContain("mock (mock, https://never.invalid)")
    } finally {
      off()
      await attachment.detach()
      await runtime.stop()
      remove(cwd)
    }
  },
)

test.each([
  {
    baseUrl:
      "https://user:URL_PASSWORD@never.invalid/v1?key=URL_KEY&api%2Dkey=DASH_KEY&Access_Token=ACCESS_VALUE&X-Amz-Signature=SIGNATURE_VALUE&region=west#FRAGMENT_SECRET",
    expected: "https://never.invalid/v1?region=west",
  },
  { baseUrl: "https://NeVeR.InVaLiD:443/", expected: "https://NeVeR.InVaLiD:443/" },
  {
    baseUrl:
      "HtTpS://user:URL_PASSWORD@NeVeR.InVaLiD:443/%2f%7e?region=%77est&&api%2Dkey=DASH_KEY&space=a+b&path=%2f&bare&#FRAGMENT_SECRET",
    expected: "HtTpS://NeVeR.InVaLiD:443/%2f%7e?region=%77est&&space=a+b&path=%2f&bare&",
  },
  {
    baseUrl: "HTTPS://user:URL_PASSWORD@NeVeR.InVaLiD:443?key=URL_KEY&region=a%20b",
    expected: "HTTPS://NeVeR.InVaLiD:443?region=a%20b",
  },
])(
  "local /status redacts credentials without changing other URL spelling in output/events: %s",
  async ({ baseUrl, expected }) => {
    const cwd = root()
    const session = await createSession({
      cwd,
      ai: mockAi(baseUrl),
      model: "mock/test",
      autoTitle: false,
      extensions: [],
      noBuiltins: false,
      builtins: async () => [{ source: "builtin:commands", extension: commands }],
    })
    const host = createCommandHost({ session, cwd })
    const events: AnyEvent[] = []
    const off = session.agent.bus.subscribe((event) => {
      events.push(event)
    })
    try {
      expect(host.control.providers()[0]!.baseUrl).toBe(baseUrl)
      session.agent.bus.emit("workspace.changed", { cwd }, { sessionId: session.agent.sessionId })
      await session.agent.bus.flush()
      const result = await host.run("/status", { frontend: "print" })
      await session.agent.bus.flush()
      expect(result.ok).toBe(true)
      assertSafe(result, events, [
        "URL_PASSWORD",
        "URL_KEY",
        "DASH_KEY",
        "ACCESS_VALUE",
        "SIGNATURE_VALUE",
        "FRAGMENT_SECRET",
        "MOCK_KEY_SENTINEL",
        "user:",
      ])
      expect(result.output.join("\n")).toContain(expected)
      expect(
        events.some((event) => event.type === "command.output" && event.data.text.includes(expected)),
      ).toBe(true)
      expect(host.control.providers()[0]!.baseUrl).toBe(baseUrl)
    } finally {
      off()
      await session.agent.dispose("exit")
      session.host.unloadAll()
      await session.host.drain()
      await session.traceRecorder?.close()
      remove(cwd)
    }
  },
)
