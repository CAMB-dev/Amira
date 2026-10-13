import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent, CommandContext, SessionControl } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { CommandHost, CommandRegistry } from "../src/commands.ts"
import { EventBus } from "../src/event-bus.ts"
import { SessionStore } from "../src/session-store.ts"
import { UiRequests } from "../src/ui-requests.ts"

test("a retained printer drops deleted-session output with a warning, without throwing or changing sessions", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-deleted-command-output-"))
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((event) => void events.push(event))
  const originalStore = SessionStore.create({ cwd: dir, dir })
  originalStore.append({ type: "display", text: "previous output", level: "info" })
  const nextStore = SessionStore.create({ cwd: dir, dir })
  const original = new Agent({ ai, bus, model: ai.model("mock/m"), cwd: dir, session: originalStore })
  const next = new Agent({ ai, bus, model: ai.model("mock/m"), cwd: dir, session: nextStore })
  const registry = new CommandRegistry()
  let print!: CommandContext["print"]
  registry.register(
    {
      name: "btw",
      description: "retain printer",
      run: (_args, ctx) => {
        print = ctx.print
      },
    },
    "test",
  )
  const host = new CommandHost({
    registry,
    bus,
    agent: original,
    ui: new UiRequests(bus),
    control: {} as SessionControl,
  })
  try {
    expect((await host.run("/btw", { frontend: "tui" })).ok).toBe(true)
    await original.dispose("switch")
    host.switchTo(next)
    rmSync(originalStore.file)
    expect(() =>
      print("private late answer", "info", { details: "secret details", persist: true }),
    ).not.toThrow()
    await bus.flush()
    expect(nextStore.entries.filter((entry) => entry.type === "display")).toEqual([])
    expect(originalStore.entries.filter((entry) => entry.type === "display")).toHaveLength(1)
    expect(existsSync(originalStore.file)).toBe(false)
    expect(events.filter((event) => event.type === "command.output")).toEqual([])
    const warnings = events.filter((event) => event.type === "extension.notice")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.data.level).toBe("warning")
    expect(warnings[0]?.data.text).toContain(original.sessionId)
    expect(warnings[0]?.data.text).not.toContain("private late answer")
    expect(warnings[0]?.data.text).not.toContain("secret details")
  } finally {
    await original.dispose()
    await next.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
