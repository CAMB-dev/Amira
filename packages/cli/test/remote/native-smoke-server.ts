import "./native-smoke-fixture.ts"
import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { createAi, createMockDialect } from "@amira/ai"
import { waitForSpawnWork } from "../../../../scripts/spawn-test.ts"
import { workspaceAttachments } from "../../src/server/attachments.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import { smokeAnswer, smokePrompt, smokeRelease } from "./native-smoke-fixture.ts"

const [workspace, report] = process.argv.slice(2)
assert(workspace && report)
const mock = createMockDialect([{ text: smokeAnswer }])
const runtime = await createWorkspaceRuntime({
  cwd: workspace,
  ai: createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] }),
  model: "mock/test",
  autoTitle: false,
  builtins: async () => [],
})
const connection = workspaceAttachments(runtime, { heartbeatMs: 0 }).connect(
  {
    input: process.stdin,
    write: (bytes) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()))
      }),
    close: () => process.stdin.destroy(),
  },
  { release: smokeRelease, workspace },
)
try {
  await waitForSpawnWork("native server handshake", connection.ready)
  await waitForSpawnWork("native client detach", connection.closed, 60_000)
  assert.equal(runtime.signal.aborted, false, "detaching must not stop the remote runtime")
  assert.equal(mock.requests.length, 1)
  assert(JSON.stringify(mock.requests).includes(smokePrompt))
  await writeFile(
    report,
    JSON.stringify({ mockRequests: mock.requests.length, detachedWithoutStopping: true }),
  )
} finally {
  connection.close()
  await runtime.stop()
}
