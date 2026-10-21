import "../server/offline.ts"
import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { type FrontendEffect, runInteractive } from "@amira/tui"
import { FakeTerminal, stripAnsi } from "@amira/tui-kit"
import { noProbe } from "../../../tui/test/app-harness.ts"
import { remotePresentationPort } from "../../src/remote/presentation-port.ts"
import { createRemoteViews } from "../../src/remote/views.ts"
import { agentPortFixture, until } from "./agent-port-fixture.ts"

const file = "file:///C:/Windows/win.ini"
const editor = "vscode://file/C:/Windows/win.ini"
const web = "https://example.invalid/remote-source"
const text = `[remote file](${file}) [remote editor](${editor}) [remote web](${web})`

// renderMarkdown's fallback reads process.env, not runInteractive's injected terminal env.
// Enable both so a forgotten host policy is observably unsafe rather than silently inert.
test("remote subagent history renders web links but never local file/editor OSC 8 targets", async () => {
  const previous = process.env.FORCE_HYPERLINK
  process.env.FORCE_HYPERLINK = "1"
  const mock = createMockDialect([{ text }])
  let childId = ""
  const f = await agentPortFixture({
    ai: createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }], env: {} }),
    builtins: async () => [
      {
        source: "test:links",
        extension(api) {
          api.registerCommand({
            name: "link-child",
            description: "Create a child with link-bearing history",
            async run(_args, ctx) {
              const group = ctx.session.createGroup!({ name: "Links" })
              const child = group.spawn({ prompt: "show links" })
              childId = child.id
              await child.result()
              group.end()
            },
          })
        },
      },
    ],
  })
  const presentation = remotePresentationPort(f.port)
  const views = createRemoteViews(f.port)
  const terminal = new FakeTerminal(120, 35)
  const ready = Promise.withResolvers<void>()
  let effect: ((event: FrontendEffect) => void) | undefined
  let exited: Promise<number> | undefined
  try {
    await f.port.execute("command.run", { line: "/link-child" })
    expect(childId).not.toBe("")
    exited = runInteractive({
      frontend: presentation.frontend,
      status: presentation.status,
      views,
      subscribeFrontendEffects(listener) {
        effect = listener
        return () => {}
      },
      terminal,
      setup: noProbe,
      env: { FORCE_HYPERLINK: "1" },
      settings: { margin: 0, marginRows: 0 },
      onReady: () => ready.resolve(),
    })
    await ready.promise
    terminal.clearWrites()
    effect!({ kind: "view", view: "subagent", id: childId })
    await until(() => stripAnsi(terminal.output).includes("remote web"))
    expect(terminal.output).toContain(`\x1b]8;;${web}\x07`)
    expect(terminal.output).not.toContain(`\x1b]8;;${file}\x07`)
    expect(terminal.output).not.toContain(`\x1b]8;;${editor}\x07`)
    expect(stripAnsi(terminal.output)).toContain("remote file")
    expect(stripAnsi(terminal.output)).toContain("remote editor")
  } finally {
    effect?.({ kind: "detach" })
    await exited
    views.dispose()
    presentation.dispose()
    await f.close()
    if (previous === undefined) delete process.env.FORCE_HYPERLINK
    else process.env.FORCE_HYPERLINK = previous
  }
})
