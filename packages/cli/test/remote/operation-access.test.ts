import { expect, test } from "bun:test"
import { REMOTE_OPERATION_ACCESS, REMOTE_OPERATIONS } from "../../src/remote/protocol.ts"
import { VIEWER_LONG_READS } from "../../src/server/reader.ts"

test("every operation is classified exactly once on both axes", () => {
  expect(Object.keys(REMOTE_OPERATION_ACCESS).sort()).toEqual([...REMOTE_OPERATIONS].sort())
  for (const access of Object.values(REMOTE_OPERATION_ACCESS)) {
    expect(Object.keys(access).sort()).toEqual(["ledger", "viewer"])
    // A viewer never writes the ledger: it holds no lease and shares no ledger scope.
    expect(access.ledger && access.viewer).toBe(false)
  }
})

test("the ledger axis keeps today's unledgered set", () => {
  const unledgered: string[] = REMOTE_OPERATIONS.filter((op) => !REMOTE_OPERATION_ACCESS[op].ledger)
  expect(unledgered.sort()).toEqual(
    [
      "state.read",
      "transcript.read",
      "commands.describe",
      "commands.complete",
      "session.planRewind",
      "sessions.list",
      "sessions.read",
      "models.list",
      "proxy.describe",
      "status.read",
      "files.list",
      "files.refresh",
      "files.cancel",
      "images.read",
      "artifacts.read",
      "uploads.begin",
      "uploads.chunk",
      "uploads.finish",
      "uploads.cancel",
      "jobs.list",
      "jobs.output",
      "jobs.wait",
      "conversations.list",
      "conversations.history",
      "form.evaluate",
      "model.stream",
      "model.compact",
      "model.open",
    ].sort(),
  )
})

test("viewers get pure reads only; shared listings, extension code, staging and turn.abort stay controller-only", () => {
  const viewer: string[] = REMOTE_OPERATIONS.filter((op) => REMOTE_OPERATION_ACCESS[op].viewer)
  expect(viewer.sort()).toEqual(
    [
      "state.read",
      "transcript.read",
      "status.read",
      "models.list",
      "commands.describe",
      "sessions.list",
      "sessions.read",
      "session.planRewind",
      "jobs.list",
      "jobs.output",
      "jobs.wait",
      "conversations.list",
      "conversations.history",
      "images.read",
      "artifacts.read",
    ].sort(),
  )
  for (const op of VIEWER_LONG_READS) expect(REMOTE_OPERATION_ACCESS[op].viewer).toBe(true)
})
