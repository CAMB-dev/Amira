import { expect, spyOn, test } from "bun:test"
import * as api from "@amira/api"
import { bashTool, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, powershellTool } from "../src/bash.ts"
import { shellPresenter } from "../src/presenters.ts"
import { StandbyPool } from "../src/standby.ts"
import { makeCtx, textOf } from "./util.ts"

const timedOut: api.HostRunResult = {
  output: "before\n",
  exitCode: null,
  signalCode: null,
  timedOut: true,
  aborted: false,
  settled: true,
  contained: true,
}

for (const tool of [bashTool, powershellTool]) {
  test(`${tool.name}: timeout default, bounds, and recovery guidance reach the runner and model`, async () => {
    // Observe the real tool's runner boundary without waiting ten minutes or spawning a shell.
    const direct = spyOn(api, "hostRunCommand").mockResolvedValue(timedOut)
    const pooled = spyOn(StandbyPool.prototype, "run").mockResolvedValue(timedOut)
    try {
      expect(DEFAULT_TIMEOUT_MS).toBe(600_000)
      expect(MAX_TIMEOUT_MS).toBe(600_000)
      expect(tool.description).toContain("default 600000, max 600000")
      expect(tool.parameters).toMatchObject({
        properties: {
          timeout: { type: "integer", minimum: 1, maximum: 600_000 },
        },
      })
      for (const [timeout, expected] of [
        [undefined, 600_000],
        [1000, 1000],
        [1000.9, 1000],
        [0, 1],
        [-1, 1],
        [600_000, 600_000],
        [900_000, 600_000],
      ] as const) {
        direct.mockClear()
        pooled.mockClear()
        const args = { command: "echo before", ...(timeout === undefined ? {} : { timeout }) }
        const result = await tool.execute(args, makeCtx(process.cwd()))
        const runner = tool === bashTool ? direct : pooled
        expect(runner).toHaveBeenCalledTimes(1)
        expect(runner.mock.calls[0]?.[1].timeoutMs).toBe(expected)
        expect(result.isError).toBe(true)
        expect(result.details).toMatchObject({ timedOut: true, exitCode: null, outputLines: 1 })
        const text = textOf(result)
        expect(text).toContain(`Command timed out after ${expected} ms and was killed.`)
        expect(text).toContain("`background: true`")
        expect(text).toContain("job_output")
        if (expected < MAX_TIMEOUT_MS) expect(text).toContain("longer `timeout`")
        else expect(text).not.toContain("longer `timeout`")
        // Recovery guidance is for the model, not output printed by the command.
        expect(
          shellPresenter.body!(
            { args, result: { ...result, details: undefined }, text },
            { detail: "summary", width: 80 },
          ),
        ).toEqual([{ kind: "code", text: "before" }])
      }
    } finally {
      direct.mockRestore()
      pooled.mockRestore()
    }
  })
}
