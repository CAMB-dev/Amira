import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { SessionStore } from "../src/session-store.ts"

test("owned identity survives storage and rejects generic execution, fork and a second claimed view", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "amira-owned-boundary-"))
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "https://provider.invalid" }],
  })
  const owned = {
    v: 1 as const,
    owner: "notes",
    spec: {
      key: "design",
      name: "Design",
      cwd: home,
      model: "mock/test",
      systemPrompt: "Research.",
      callableTools: ["read"],
    },
    runtimeTools: [],
  }
  const store = SessionStore.create({ cwd: home, dir: home, owned })
  let authorized: Agent | undefined
  try {
    store.appendDisplay({ type: "display", text: "created", level: "info" })
    const reopened = SessionStore.open(store.file)
    expect(reopened.header.owned).toEqual(owned)
    expect(() => new Agent({ ai, model: ai.model("mock/test"), cwd: home, session: reopened })).toThrow(
      "owned conversation",
    )
    expect(() => reopened.fork()).toThrow("owned conversation")
    authorized = new Agent({
      ai,
      model: ai.model("mock/test"),
      cwd: home,
      session: reopened,
      ownedConversation: "notes",
    })
    expect(() => SessionStore.open(store.file).claim()).toThrow("in use")
    await authorized.dispose()
    // Release must not erase the marker or turn the saved history into an unrestricted root.
    const released = SessionStore.open(store.file)
    expect(() => new Agent({ ai, model: ai.model("mock/test"), cwd: home, session: released })).toThrow(
      "owned conversation",
    )
  } finally {
    await authorized?.dispose()
    store.release()
    rmSync(home, { recursive: true, force: true })
  }
})
