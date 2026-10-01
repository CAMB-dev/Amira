import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type ModelRequest } from "@amira/ai"
import builtinTools from "@amira/builtin-tools"
import { Agent, AgentTree, EventBus, ExtensionHost, InterceptorRegistry, ToolRegistry } from "@amira/core"
import { backgroundJobs } from "@amira/proc"

// Spawns can stall for seconds on Windows machines with antivirus scanning.
setDefaultTimeout(60_000)

const dirs: string[] = []
afterAll(async () => {
  await backgroundJobs.stopAll(() => true, 0)
  for (const d of dirs) await rm(d, { recursive: true, force: true })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function waitUntil(check: () => boolean, what: string, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(20)
  }
}

// The same command line in Git Bash and in the PowerShell fallback: a path without spaces.
const bun = process.execPath.replaceAll("\\", "/")

test.skipIf(bun.includes(" "))(
  "a sub-agent's background job runs while it works and is stopped when it ends; the top-level session's keeps running",
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "amira-jobs-subagent-"))
    dirs.push(dir)
    await writeFile(path.join(dir, "server.js"), "console.log('ready'); setInterval(() => {}, 1000)")
    const command = `${bun} server.js`
    const isChild = (req: ModelRequest) => req.systemPrompt.includes("ROLE child")
    const answered = (req: ModelRequest) => req.messages.at(-1)?.role === "toolResult"
    const mock = createMockDialect()
    for (let i = 0; i < 20; i++)
      mock.push((req) =>
        answered(req)
          ? { text: isChild(req) ? "server started" : "main server started" }
          : { toolCalls: [{ name: "bash", args: { command, background: true } }] },
      )
    const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
    const bus = new EventBus()
    const tools = new ToolRegistry()
    const interceptors = new InterceptorRegistry()
    const host = new ExtensionHost({ bus, interceptors, tools })
    expect(await host.load(builtinTools, "builtin:tools")).toBe(true)
    const tree = new AgentTree({ ai, sections: () => [] })
    const root = new Agent({
      ai,
      model: ai.model("mock/m"),
      cwd: dir,
      systemPrompt: "root",
      bus,
      tree,
      tools,
      interceptors,
    })

    // The top-level session's job: it runs until stopped or Amira exits.
    await root.prompt("start the main server")
    const main = backgroundJobs.list().find((j) => j.cwd === dir && j.owner === undefined)
    expect(main?.status).toBe("running")

    const child = tree.spawn(root, { prompt: "start a server", systemPrompt: "ROLE child" })
    let during: string | undefined
    const off = bus.subscribe((e) => {
      if (e.type === "subagent.end")
        during ??= backgroundJobs.list().find((j) => j.owner === child.id)?.status
    })
    const result = await child.result()
    await bus.flush()
    off()
    expect(result.text).toBe("server started")
    const job = backgroundJobs.list().find((j) => j.owner === child.id)!
    expect(job.command).toBe(command)
    // It still ran when the sub-agent ended, and then it was stopped.
    expect(during).toBe("running")
    await waitUntil(() => backgroundJobs.get(job.id)!.status === "stopped", "the sub-agent's job to stop")
    await waitUntil(() => !alive(job.pid!), "its process to end")
    expect(backgroundJobs.get(main!.id)!.status).toBe("running")
    await backgroundJobs.stop(main!.id, 0)
    host.unloadAll()
  },
)
