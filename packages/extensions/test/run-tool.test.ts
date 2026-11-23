import { afterEach, expect, spyOn, test } from "bun:test"
import * as proc from "@amira/proc"
import { runTool, ToolError } from "../src/run.ts"

const spies: { mockRestore(): void }[] = []
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore()
})

function finishedFirst() {
  // The command exited 0 before the cancel reached it, as a fast tar does on Linux.
  spies.push(
    spyOn(proc, "runCommand").mockResolvedValue({
      output: "done",
      truncated: false,
      exitCode: 0,
      signalCode: null,
      timedOut: false,
      aborted: false,
      settled: true,
    } as Awaited<ReturnType<typeof proc.runCommand>>),
  )
}

test("a cancel that fired wins over a command that finished first", async () => {
  finishedFirst()
  const abort = new AbortController()
  abort.abort()
  const error = await runTool(["tar", "-xzf", "x.tgz"], ".", "tar", { signal: abort.signal }).catch(
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ToolError)
  expect((error as ToolError).aborted).toBe(true)
  expect((error as ToolError).message).toBe("tar was cancelled:\ndone")
})

test("a finished command without a cancel returns its output", async () => {
  finishedFirst()
  const abort = new AbortController()
  expect(await runTool(["tar", "-xzf", "x.tgz"], ".", "tar", { signal: abort.signal })).toBe("done")
})
