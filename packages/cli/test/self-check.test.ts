import { afterEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { commandWorkerStatus, resetCommandWorker } from "@amira/proc"
import { selfCheck } from "../src/self-check.ts"
import { channel, target, version, versionLine } from "../src/version.ts"

afterEach(() => resetCommandWorker())

test("self-check verifies the Worker handshake, theme and platform containment", async () => {
  resetCommandWorker()
  expect(commandWorkerStatus()).toBe("idle")
  const report = await selfCheck()
  expect(report).toEqual({
    ok: true,
    version,
    channel,
    target,
    worker: "worker",
    assets: true,
    jobObject: process.platform === "win32" ? true : null,
    errors: [],
  })
})

test("self-check fails rather than accepting inline fallback", async () => {
  resetCommandWorker({ url: new URL("./missing-worker.ts", import.meta.url).href })
  const report = await selfCheck()
  expect(report.ok).toBe(false)
  expect(report.worker).toBe("inline")
  expect(report.errors).toContain("Command Worker did not send ready: inline")
})

test("CLI diagnostics print metadata and JSON without needing configuration", async () => {
  const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url))
  for (const flag of ["--version", "--self-check"]) {
    const child = Bun.spawn([process.execPath, entry, flag], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code).toBe(0)
    expect(stderr).toBe("")
    if (flag === "--version") expect(stdout.trim()).toBe(versionLine)
    else expect(JSON.parse(stdout).ok).toBe(true)
  }
}, 30_000)
