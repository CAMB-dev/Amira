import "../server/offline.ts"
import { expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi } from "@amira/ai"
import { BindingApprovals } from "../../src/remote/binding-approvals.ts"
import { ProviderBindings } from "../../src/remote/provider-bindings.ts"

test("one-time provider approval is authority/workspace scoped and invalidated by local credential changes", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "amira-binding-approval-"))
  const env = { FIXTURE_KEY: "LOCAL_APPROVAL_SECRET" }
  const ai = createAi({
    env,
    providers: [
      { id: "p", dialect: "openai-chat", baseUrl: "https://billing.invalid/v1", apiKeyEnv: "FIXTURE_KEY" },
    ],
  })
  const bindings = new ProviderBindings(ai)
  const identity = {
    provider: "p",
    localProvider: "p",
    dialect: "openai-chat",
    endpointOrigin: "https://billing.invalid",
    remoteOrigin: "https://remote.invalid",
  }
  try {
    const store = new BindingApprovals(home, "host", "/work")
    const receipt = bindings.approvalFingerprint(identity)
    expect(await store.approved(identity, receipt)).toBe(false)
    await store.remember(identity, receipt)
    expect(await new BindingApprovals(home, "host", "/work").approved(identity, receipt)).toBe(true)
    expect(await new BindingApprovals(home, "other-host", "/work").approved(identity, receipt)).toBe(false)
    expect(await new BindingApprovals(home, "host", "/other").approved(identity, receipt)).toBe(false)
    expect(await store.approved({ ...identity, remoteOrigin: "https://changed.invalid" }, receipt)).toBe(
      false,
    )
    env.FIXTURE_KEY = "CHANGED_LOCAL_APPROVAL_SECRET"
    expect(await store.approved(identity, bindings.approvalFingerprint(identity))).toBe(false)
    const root = path.join(home, "remote", "bindings")
    const directory = (await readdir(root))[0]!
    const file = (await readdir(path.join(root, directory)))[0]!
    const saved = await readFile(path.join(root, directory, file), "utf8")
    expect(saved).not.toContain("LOCAL_APPROVAL_SECRET")
    expect(JSON.parse(saved)).toEqual({ schema: 1, fingerprint: receipt })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
