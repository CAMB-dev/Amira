import "../server/offline.ts"
import { expect, test } from "bun:test"
import { bindLocalCommandContext } from "@amira/core"
import { remotePresentationPort } from "../../src/remote/presentation-port.ts"
import type { RemoteWorkspaceSnapshot } from "../../src/remote-schema.ts"
import { agentPortFixture, until } from "./agent-port-fixture.ts"

test("a command response cannot retire its frontend callbacks before backlogged live effects apply", async () => {
  const blocked = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let hold = false
  let commands = 0
  let response = false
  const wireOrder: string[] = []
  const f = await agentPortFixture(
    {
      builtins: async () => [
        {
          source: "test:effect",
          extension(api) {
            api.registerCommand({
              name: "show",
              description: "test",
              run(_args, ctx) {
                commands++
                ctx.openView?.({ kind: "background-job", data: { id: "job-1" } })
              },
            })
          },
        },
      ],
    },
    {},
    {
      async serverWrite(bytes) {
        const text = Buffer.from(bytes).toString()
        if (hold && text.includes('"kind":"event"')) {
          hold = false
          blocked.resolve()
          await release.promise
        }
        if (text.includes('"kind":"response"') && text.includes('"op":"command.run"')) {
          response = true
          wireOrder.push("response")
        }
        if (text.includes('"kind":"effect"')) wireOrder.push("effect")
      },
    },
  )
  const presentation = remotePresentationPort(f.port)
  const unbind = bindLocalCommandContext(presentation.frontend, "invocation-1", {
    frontend: "tui",
    isFrontendCurrent: () => true,
  })
  const effects: string[] = []
  const off = presentation.subscribeFrontendEffects((effect) => effects.push(effect.kind))
  try {
    const state = f.runtime.workspaceSnapshot() as unknown as RemoteWorkspaceSnapshot
    hold = true
    for (let i = 0; i < 10; i++) f.runtime.journal.append({ kind: "semantic", semantic: state.semantic })
    await blocked.promise
    const run = presentation.frontend
      .execute("command.run", { line: "/show", invocationId: "invocation-1" })
      .finally(unbind)
    await until(() => commands === 1)
    release.resolve()
    const result = await run
    expect(response).toBe(true)
    expect(wireOrder).toEqual(["response", "effect"])
    expect(result.ok).toBe(true)
    expect(effects).toEqual(["view"])
  } finally {
    release.resolve()
    off()
    unbind()
    presentation.dispose()
    await f.close()
  }
})
