import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { boundedExit, READER_READY_TIMEOUT_MS, startGateReader } from "./file-lock-reader-fixture.ts"

if (process.platform === "win32") {
  const timeout = READER_READY_TIMEOUT_MS * 2 + 5000
  for (const startup of ["slow", "crash"] as const) {
    test(
      `Windows reader readiness diagnoses ${startup} startup separately from contention`,
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-reader-startup-"))
        const metadata = path.join(dir, "owner.json")
        fs.writeFileSync(metadata, "reader fixture")
        const spawn = Bun.spawn
        const hook = spyOn(Bun, "spawn").mockImplementationOnce((...parameters) => {
          const [command, options] = parameters
          if (!Array.isArray(command)) throw new Error("reader command required")
          const args = [...command]
          args[args.length - 1] =
            startup === "slow"
              ? `Start-Sleep -Milliseconds 10000\n${args.at(-1)}`
              : "[Console]::Error.WriteLine('reader startup probe failed'); exit 7"
          return spawn(args, options as Parameters<typeof Bun.spawn>[1])
        })
        const start = performance.now()
        const { reader, go, stderr, waitUntilReady } = startGateReader(metadata, dir)
        hook.mockRestore()
        try {
          if (startup === "crash") {
            await expect(waitUntilReady()).rejects.toThrow(
              "reader readiness exited: exitCode=7, signalCode=null\nstderr:\nreader startup probe failed",
            )
          } else {
            await waitUntilReady()
            expect(performance.now() - start).toBeGreaterThanOrEqual(10000)
            expect(reader.exitCode).toBeNull()
            fs.writeFileSync(go, "go")
            expect(await boundedExit(reader, "slow reader")).toBe(0)
            expect(await stderr).toBe("")
          }
        } finally {
          if (reader.exitCode === null) reader.kill()
          await boundedExit(reader, "owned startup reader")
          fs.rmSync(dir, { recursive: true, force: true })
        }
      },
      timeout,
    )
  }

  test(
    "Windows reader keeps its handle until go when the ready parent is delayed",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-reader-parent-delay-"))
      const metadata = path.join(dir, "owner.json")
      fs.writeFileSync(metadata, "reader fixture")
      const { reader, go, stderr, waitUntilReady } = startGateReader(metadata, dir)
      try {
        await waitUntilReady()
        // Simulate a descheduled parent, not the measured deny-delete interval.
        await Bun.sleep(3500)
        expect(reader.exitCode).toBeNull()
        fs.writeFileSync(go, "go")
        expect(await boundedExit(reader, "delayed parent reader")).toBe(0)
        expect(await stderr).toBe("")
      } finally {
        if (reader.exitCode === null) reader.kill()
        await boundedExit(reader, "owned delayed parent reader")
        fs.rmSync(dir, { recursive: true, force: true })
      }
    },
    timeout,
  )
}
