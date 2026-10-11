import { expect, test } from "bun:test"

test("the public proc exports stay stable", async () => {
  expect(Object.keys(await import("../src/index.ts")).sort()).toEqual([
    "DEFAULT_BUFFER_CHARS",
    "DEFAULT_MAX_LOG_BYTES",
    "DEFAULT_MAX_OUTPUT_CHARS",
    "DEFAULT_MAX_RUNNING",
    "DRAIN_GRACE_MS",
    "JOB_DRAIN_MS",
    "JobLimitError",
    "JobRegistry",
    "PASSIVE_SIGNAL_LISTENER",
    "StandbyGoneError",
    "backgroundJobs",
    "cmdArgv",
    "commandWorkerStatus",
    "killLiveJobs",
    "killLivePipes",
    "liveJobPids",
    "livePipePids",
    "openPipe",
    "prepareCommand",
    "prepareCommandInline",
    "resetCommandWorker",
    "runCommand",
    "runCommandInline",
    "startJob",
    "startJobInline",
    "trackProcessTree",
    "warmUpCommands",
    "warmUpProcessTree",
  ])
})
