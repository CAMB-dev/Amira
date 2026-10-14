import { expect, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  assertInlineResponsive,
  INLINE_LATENCY_REPORT,
  INLINE_LATENCY_RUNS,
  type InlineLatencySample,
} from "./file-lock-latency-timing.ts"

const modes = ["claim", "release", "reclaim", ...(process.platform === "win32" ? ["windows-reader"] : [])]
for (const mode of modes) {
  test(
    `100ms gate reader keeps ${mode} inline and automatic cleanup responsive`,
    async () => {
      const samples: InlineLatencySample[] = []
      for (let run = 0; run < INLINE_LATENCY_RUNS; run++) {
        // Each repetition has a new process and filesystem fixture. Reusing an
        // already release-requested gate would not repeat the contended operation.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-lock-latency-"))
        const worker = Bun.spawn(
          [
            process.execPath,
            "--preload",
            path.join(import.meta.dir, "file-lock-worker-preload.ts"),
            path.join(
              import.meta.dir,
              mode === "windows-reader"
                ? "file-lock-latency-reader-worker.ts"
                : "file-lock-latency-worker.ts",
            ),
            dir,
            mode,
          ],
          {
            env: Object.fromEntries(
              Object.entries(process.env).filter(([name]) => !name.startsWith("AMIRA_LIVE_")),
            ),
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const stdout = new Response(worker.stdout).text()
        const stderr = new Response(worker.stderr).text()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            worker.exited,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("latency worker timed out")), 4000)
            }),
          ])
          const lines = (await stdout).split("\n")
          console.log(
            lines
              .filter((line) => !line.startsWith(INLINE_LATENCY_REPORT))
              .join("\n")
              .trim(),
          )
          // Structural and automatic-callback checks must pass in EVERY fixture.
          expect(await stderr).toBe("")
          expect(worker.exitCode).toBe(0)
          const reports = lines.filter((line) => line.startsWith(INLINE_LATENCY_REPORT))
          expect(reports).toHaveLength(1)
          samples.push(...JSON.parse(reports[0]!.slice(INLINE_LATENCY_REPORT.length)))
        } finally {
          clearTimeout(timer)
          if (worker.exitCode === null) worker.kill()
          await worker.exited
          fs.rmSync(dir, { recursive: true, force: true })
        }
      }
      const entries =
        mode === "reclaim"
          ? ["unlock", "release", "reclaim"]
          : mode === "windows-reader"
            ? ["release", "unlock"]
            : [mode]
      assertInlineResponsive(mode, samples, entries)
      // Keep each worker's existing budget; the test now performs three fixtures.
    },
    7000 * INLINE_LATENCY_RUNS,
  )
}
