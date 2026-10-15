import { expect, test } from "bun:test"
import { createPowershellTool } from "../src/bash.ts"
import { makeCtx, textOf } from "./util.ts"

test("powershell refuses an execution context authorized as bash before starting a job", async () => {
  const tool = createPowershellTool("fake-powershell.exe")
  const result = await tool.execute(
    { command: "Write-Output ignored", background: true },
    { ...makeCtx(process.cwd()), shellKind: "bash" },
  )
  expect(result.isError).toBe(true)
  expect(textOf(result)).toContain("shell changed after authorization")
})
