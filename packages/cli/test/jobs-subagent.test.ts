import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type ModelRequest } from "@amira/ai"
import { Agent, AgentTree, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { backgroundJobs } from "@amira/proc"
import {
  SPAWN_TEST_TIMEOUT_MS,
  waitForSpawnCondition,
  waitForSpawnWork,
} from "../../../scripts/spawn-test.ts"
import { builtinToolsWithoutWarmup as builtinTools } from "../../../scripts/test-builtin-tools.ts"

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

// The same command line in Git Bash and in the PowerShell fallback: a path without spaces.
const bun = process.execPath.replaceAll("\\", "/")

test.skipIf(bun.includes(" "))(
  "a sub-agent's background job runs while it works and is stopped when it ends; the top-level session's keeps running",
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "amira-jobs-subagent-"))
    let root: Agent | undefined
    let off: (() => void) | undefined
    const bus = new EventBus()
    const tools = new ToolRegistry()
    const interceptors = new InterceptorRegistry()
    const host = new ExtensionHost({ bus, interceptors, tools })
    try {
      await writeFile(path.join(dir, "server.js"), "console.log('ready'); setInterval(() => {}, 1000)")
      const command = `${bun} server.js`
      const isChild = (req: ModelRequest) => req.systemPrompt.includes("ROLE child")
      const answered = (req: ModelRequest) => req.messages.at(-1)?.role === "toolResult"
      const mock = createMockDialect()
      // A slow spawn can outlast the tool's startup observation. Keep the model working
      // until its job is running, rather than assuming it starts within that observation.
      for (let i = 0; i < 20; i++)
        mock.push((req) =>
          answered(req)
            ? {
                text: isChild(req) ? "server started" : "main server started",
                hold: {
                  chunks: 0,
                  until: waitForSpawnCondition(
                    "the server to start",
                    () =>
                      backgroundJobs
                        .list()
                        .some(
                          (j) =>
                            j.cwd === dir &&
                            (j.owner !== undefined) === isChild(req) &&
                            j.status === "running",
                        ),
                    20_000,
                  ),
                },
              }
            : { toolCalls: [{ name: "bash", args: { command, background: true } }] },
        )
      const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
      expect(await waitForSpawnWork("jobs builtin loading", host.load(builtinTools, "builtin:tools"))).toBe(
        true,
      )
      const tree = new AgentTree({ ai, sections: () => [] })
      root = new Agent({
        ai,
        model: ai.model("mock/m"),
        cwd: dir,
        systemPrompt: "root",
        bus,
        tree,
        tools,
        interceptors,
        backgroundJobs: host.backgroundJobs,
      })

      // The top-level session's job: it runs until stopped or Amira exits.
      await waitForSpawnWork("main server prompt", root.prompt("start the main server"))
      const main = backgroundJobs.list().find((j) => j.cwd === dir && j.owner === undefined)
      expect(main?.status).toBe("running")

      const child = tree.spawn(root, { prompt: "start a server", systemPrompt: "ROLE child" })
      let during: string | undefined
      off = bus.subscribe((e) => {
        if (e.type === "subagent.end")
          during ??= backgroundJobs.list().find((j) => j.owner === child.id)?.status
      })
      const result = await waitForSpawnWork("sub-agent server result", child.result())
      await waitForSpawnWork("sub-agent end events", bus.flush())
      off()
      expect(result.text).toBe("server started")
      const job = backgroundJobs.list().find((j) => j.owner === child.id)!
      expect(job.command).toBe(command)
      // It still ran when the sub-agent ended, and then it was stopped.
      expect(during).toBe("running")
      await waitForSpawnCondition(
        "the sub-agent's job to stop",
        () => backgroundJobs.get(job.id)!.status === "stopped",
        20_000,
      )
      await waitForSpawnCondition("its process to end", () => !alive(job.pid!), 20_000)
      expect(backgroundJobs.get(main!.id)!.status).toBe("running")
      await waitForSpawnWork("main server stop", backgroundJobs.stop(main!.id, 0))
    } finally {
      off?.()
      try {
        if (root) await waitForSpawnWork("jobs agent disposal", root.dispose("exit"))
      } finally {
        try {
          await waitForSpawnWork(
            "owned jobs cleanup",
            backgroundJobs.stopAll((job) => job.cwd === dir, 0),
          )
          await waitForSpawnCondition("owned job processes to exit", () =>
            backgroundJobs
              .list()
              .filter((job) => job.cwd === dir)
              .every((job) => !["starting", "running"].includes(job.status) && (!job.pid || !alive(job.pid))),
          )
        } finally {
          host.unloadAll()
          await rm(dir, { recursive: true, force: true })
        }
      }
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)
