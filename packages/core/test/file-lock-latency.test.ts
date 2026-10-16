import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { SPAWN_TEST_TIMEOUT_MS, waitForSpawnWork } from "../../../scripts/spawn-test.ts"
import {
  assertInlineResponsive,
  INLINE_LATENCY_REPORT,
  INLINE_LATENCY_RUNS,
  type InlineLatencySample,
  LATENCY_WORKER_READY,
  LATENCY_WORKER_READY_TIMEOUT_MS,
} from "./file-lock-latency-timing.ts"
import { waitForFileLockCondition, waitForFileLockWorkerExit } from "./file-lock-test-waits.ts"

async function runLatencyWorker(mode: string): Promise<InlineLatencySample[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-lock-latency-"))
  const worker = Bun.spawn(
    [
      process.execPath,
      "--preload",
      path.join(import.meta.dir, "file-lock-worker-preload.ts"),
      path.join(
        import.meta.dir,
        mode === "windows-reader" ? "file-lock-latency-reader-worker.ts" : "file-lock-latency-worker.ts",
      ),
      dir,
      mode,
    ],
    {
      windowsHide: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith("AMIRA_LIVE_")),
      ),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const stdout = new Response(worker.stdout).text()
  const stderr = new Response(worker.stderr).text()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const ready = path.join(dir, LATENCY_WORKER_READY)
    await waitForFileLockCondition(
      "latency worker readiness",
      () => {
        if (worker.exitCode !== null)
          throw new Error(
            `latency worker readiness exited: exitCode=${worker.exitCode}, signalCode=${worker.signalCode}`,
          )
        return fs.existsSync(ready)
      },
      LATENCY_WORKER_READY_TIMEOUT_MS,
    ).catch(async (error) => {
      if (worker.exitCode !== null)
        throw new Error(`${error.message}\nstderr:\n${await waitForSpawnWork("worker stderr drain", stderr)}`)
      throw error
    })
    // The real reader is holding its handle and warmup is complete. Only now
    // start the original operation watchdog, then explicitly release the worker.
    await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("latency worker operation timed out")), 4000)
      }),
      (async () => {
        worker.stdin.write("go")
        await worker.stdin.end()
        return worker.exited
      })(),
    ])
    const lines = (await waitForSpawnWork("worker stdout drain", stdout)).split("\n")
    console.log(
      lines
        .filter((line) => !line.startsWith(INLINE_LATENCY_REPORT))
        .join("\n")
        .trim(),
    )
    // Structural and automatic-callback checks must pass in EVERY fixture.
    expect(await waitForSpawnWork("worker stderr drain", stderr)).toBe("")
    expect(await worker.exited).toBe(0)
    const reports = lines.filter((line) => line.startsWith(INLINE_LATENCY_REPORT))
    expect(reports).toHaveLength(1)
    return JSON.parse(reports[0]!.slice(INLINE_LATENCY_REPORT.length))
  } finally {
    clearTimeout(timer)
    if (worker.exitCode === null) worker.kill()
    await waitForFileLockWorkerExit(worker, "owned latency worker")
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const modes = ["claim", "release", "reclaim", ...(process.platform === "win32" ? ["windows-reader"] : [])]
for (const mode of modes) {
  test(
    `100ms gate reader keeps ${mode} inline and automatic cleanup responsive`,
    async () => {
      const samples: InlineLatencySample[] = []
      for (let run = 0; run < INLINE_LATENCY_RUNS; run++) {
        // Each repetition has a new process and filesystem fixture. Reusing an
        // already release-requested gate would not repeat the contended operation.
        samples.push(...(await runLatencyWorker(mode)))
      }
      const entries =
        mode === "reclaim"
          ? ["unlock", "release", "reclaim"]
          : mode === "windows-reader"
            ? ["release", "unlock"]
            : [mode]
      assertInlineResponsive(mode, samples, entries)
      // Startup hang protection is separate; measured cleanup budgets are unchanged.
    },
    SPAWN_TEST_TIMEOUT_MS * INLINE_LATENCY_RUNS,
  )
}

for (const mode of ["release", "reclaim"]) {
  test(
    `latency worker finishes slow ${mode} fixture setup before readiness`,
    async () => {
      const spawn = Bun.spawn
      const hook = spyOn(Bun, "spawn").mockImplementationOnce((...parameters) => {
        const [command, options] = parameters
        if (!Array.isArray(command)) throw new Error("latency worker command required")
        const args = [...command]
        const worker = args[3]!
        const store = pathToFileURL(path.join(import.meta.dir, "../src/session-store.ts")).href
        args.splice(
          3,
          1,
          "--eval",
          `const { SessionStore } = await import(${JSON.stringify(store)});
const claim = SessionStore.prototype.claim;
let warmFile, delayed = false;
SessionStore.prototype.claim = function () {
  warmFile ??= this.file;
  if (!delayed && this.file !== warmFile) {
    delayed = true;
    const until = performance.now() + 4500;
    while (performance.now() < until) {}
  }
  return claim.call(this);
};
process.argv.splice(1, 0, ${JSON.stringify(worker)});
await import(${JSON.stringify(pathToFileURL(worker).href)});`,
        )
        return spawn(args, options as Parameters<typeof Bun.spawn>[1])
      })
      try {
        const samples = await runLatencyWorker(mode)
        expect(samples.map((sample) => sample.entry)).toEqual(
          mode === "release" ? ["release"] : ["unlock", "release", "reclaim"],
        )
      } finally {
        hook.mockRestore()
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
}

for (const startup of ["slow", "crash"] as const) {
  test(
    `latency worker diagnoses ${startup} startup separately from the operation watchdog`,
    async () => {
      const spawn = Bun.spawn
      const hook = spyOn(Bun, "spawn").mockImplementationOnce((...parameters) => {
        const [command, options] = parameters
        if (!Array.isArray(command)) throw new Error("latency worker command required")
        const args = [...command]
        const worker = args[3]!
        args.splice(
          3,
          1,
          "--eval",
          startup === "slow"
            ? `await Bun.sleep(4500); process.argv.splice(1, 0, ${JSON.stringify(worker)}); await import(${JSON.stringify(pathToFileURL(worker).href)})`
            : "console.error('latency startup probe failed'); process.exit(7)",
        )
        return spawn(args, options as Parameters<typeof Bun.spawn>[1])
      })
      try {
        if (startup === "crash") {
          await expect(runLatencyWorker("claim")).rejects.toThrow(
            "latency worker readiness exited: exitCode=7, signalCode=null\nstderr:\nlatency startup probe failed",
          )
        } else {
          const samples = await runLatencyWorker("claim")
          expect(samples.map((sample) => sample.entry)).toEqual(["claim"])
        }
      } finally {
        hook.mockRestore()
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
}
