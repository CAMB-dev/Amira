import { expect, test } from "bun:test"
import type { ShellKind } from "@amira/api"
import type { Shell } from "../src/shell.ts"
import { resolveExecutionShell, validateShellCommand } from "../src/shell-execution.ts"
import { makeCtx, textOf } from "./util.ts"

function fakeShell(kind: ShellKind): Shell {
  return {
    kind,
    path: `fake-${kind}`,
    command() {
      throw new Error("No command should be spawned by authorization tests")
    },
  }
}

for (const kind of ["bash", "powershell"] as const) {
  test(`execution accepts the authorized ${kind} dialect`, async () => {
    const shell = fakeShell(kind)
    expect(
      await resolveExecutionShell(async () => shell, { ...makeCtx(process.cwd()), shellKind: kind }),
    ).toBe(shell)
  })

  test(`execution rejects an unchecked dialect instead of authorized ${kind}`, async () => {
    await expect(
      resolveExecutionShell(async () => fakeShell(kind === "bash" ? "powershell" : "bash"), {
        ...makeCtx(process.cwd()),
        shellKind: kind,
      }),
    ).rejects.toThrow("shell changed after authorization")
  })
}

test("abort during resolution cannot start the resolved command", async () => {
  const abort = new AbortController()
  const ctx = makeCtx(process.cwd(), abort.signal)
  await expect(
    resolveExecutionShell(async () => {
      abort.abort()
      return fakeShell("bash")
    }, ctx),
  ).rejects.toThrow("Aborted before the command started")
})

test("a failed execution resolution is not retried in another dialect", async () => {
  let resolutions = 0
  await expect(
    resolveExecutionShell(async () => {
      resolutions++
      throw new Error("resolution failed")
    }, makeCtx(process.cwd())),
  ).rejects.toThrow("resolution failed")
  expect(resolutions).toBe(1)
})

test("shared command validation rejects empty and NUL input", async () => {
  const ctx = makeCtx(process.cwd())
  expect(textOf((await validateShellCommand(" ", ctx))!)).toBe("command is required")
  expect(textOf((await validateShellCommand("echo\0hidden", ctx))!)).toContain("NUL")
})
