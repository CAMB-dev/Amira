import { expect } from "bun:test"
import { existsSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  stopSpawn,
  waitForSpawnCondition,
  waitForSpawnExit,
  waitForSpawnWork,
} from "../../../scripts/spawn-test.ts"

export async function waitFor(
  file: string,
  worker: ReturnType<typeof startWorker>,
  timeoutMs?: number,
): Promise<void> {
  await waitForSpawnCondition(
    `ownership worker ${worker.pid}: ${path.basename(file)}`,
    () => {
      if (existsSync(file)) return true
      if (worker.exitCode !== null)
        throw new Error(
          `ownership worker ${worker.pid} exited (${worker.exitCode}) before ${path.basename(file)}`,
        )
      return false
    },
    timeoutMs,
  ).catch(async (error) => {
    if (worker.exitCode !== null)
      throw new Error(
        `${error.message}: ${await waitForSpawnWork("ownership worker stderr", new Response(worker.stderr).text())}`,
      )
    throw error
  })
}

export function startWorker(dir: string, file: string, mode: "resume" | "hold") {
  const module = (relative: string) => JSON.stringify(pathToFileURL(path.resolve(relative)).href)
  const preload = path.join(dir, "guard.ts")
  const script = path.join(dir, "worker.ts")
  writeFileSync(
    preload,
    `
import { isolateTestHome } from ${module("scripts/test-home.ts")}
isolateTestHome()
`,
  )
  writeFileSync(
    script,
    `
import { existsSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createAi, createMockDialect } from ${module("packages/ai/src/index.ts")}
import { Agent } from ${module("packages/core/src/agent.ts")}
import { EventBus } from ${module("packages/core/src/event-bus.ts")}
import { SessionStore } from ${module("packages/core/src/session-store.ts")}
import { waitForSpawnCondition } from ${module("scripts/spawn-test.ts")}
const [file, dir, mode] = process.argv.slice(2)
const mark = (name: string, data: unknown = {}) => {
  const file = path.join(dir, name)
  writeFileSync(file + ".tmp", JSON.stringify(data))
  renameSync(file + ".tmp", file)
}
const wait = (name: string) => waitForSpawnCondition("ownership worker protocol: " + name, () =>
  existsSync(path.join(dir, name)),
)
const store = SessionStore.open(file!)
mark("opened")
if (mode === "hold") {
  store.claim()
  mark("claimed", { pid: process.pid })
  await wait("release")
  store.release()
} else {
  await wait("claim")
  const mock = createMockDialect([{ text: "first answer" }, { text: "second answer" }])
  const ai = createAi({ dialects: [mock], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const bus = new EventBus()
  const errors: unknown[] = []
  bus.subscribe((event) => { if (event.type === "extension.error") errors.push(event.data) })
  const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: dir!, session: store, bus, sections: [] })
  try {
    await agent.prompt("first question")
    await agent.prompt("second question")
    await bus.flush()
    mark("result", {
      memory: agent.messages,
      disk: SessionStore.open(file!).restore().messages,
      errors,
      requests: mock.requests.map((request) => request.messages),
      displays: SessionStore.open(file!).entries.filter((entry) => entry.type === "display"),
    })
  } finally {
    await agent.dispose()
  }
}
`,
  )
  // HOME/USERPROFILE/AMIRA_HOME are inherited from the configured test-env isolation.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("AMIRA_LIVE_")),
  )
  return Bun.spawn([process.execPath, "--preload", preload, script, file, dir, mode], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
}

export async function finishWorker(worker: ReturnType<typeof startWorker>, dir: string) {
  try {
    const code = await waitForSpawnExit(worker, "ownership worker protocol cleanup")
    const stderr = await waitForSpawnWork("ownership worker stderr", new Response(worker.stderr).text())
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  } finally {
    // Only this test's exact subprocess is killed if protocol cleanup did not let it exit.
    await stopSpawn(worker, "ownership worker cleanup")
    rmSync(dir, { recursive: true, force: true })
  }
}
