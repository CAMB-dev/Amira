import { expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import * as core from "@amira/core"
import { createCommandHost } from "../src/control.ts"
import { createSession } from "../src/session.ts"

test("an admitted provider save keeps its durable write but cannot select a model on a replacement root", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "amira-provider-origin-"))
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const restrict = spyOn(core, "restrictToCurrentUser").mockImplementation(async () => {
    entered.resolve()
    await release.promise
    return undefined
  })
  const ai = createAi({
    dialects: [{ ...createMockDialect([]), id: "openai-chat" }],
    providers: [{ id: "d", dialect: "openai-chat", baseUrl: "https://mock.invalid" }],
  })
  const store = core.SessionStore.create({ cwd: dir, dir })
  const session = await createSession({
    ai,
    model: "d/m2",
    cwd: dir,
    store,
    noBuiltins: true,
    extensions: [],
    catalog: false,
  })
  const host = createCommandHost({ session, cwd: dir, home: dir })
  const old = host.agent
  const replacement = new core.Agent({ ai, model: ai.model("d/m2"), cwd: dir, systemPrompt: "" })
  const unregister = session.host.commands.register(
    {
      name: "save",
      description: "Save",
      run: async (_line, ctx) => {
        await ctx.session.providerAdmin!.save({
          id: "d",
          dialect: "openai-chat",
          baseUrl: "https://mock.invalid",
          models: ["m1"],
          keySource: "auth",
          apiKey: "test-only-key",
        })
      },
    },
    "test",
  )
  const pending = host.run("/save", { frontend: "tui" })
  try {
    await Promise.race([
      entered.promise,
      pending.then((result) => {
        throw new Error(result.error ?? "save returned before ACL")
      }),
    ])
    host.switchTo(replacement)
    release.resolve()
    expect((await pending).ok).toBe(true)
    expect(replacement.model.id).toBe("m2")
    expect(JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8")).providers.d.models).toEqual([
      { id: "m1" },
    ])
  } finally {
    release.resolve()
    await pending
    unregister()
    restrict.mockRestore()
    await old.dispose()
    await replacement.dispose()
    await session.host.unloadAll()
    rmSync(dir, { recursive: true, force: true })
  }
})
