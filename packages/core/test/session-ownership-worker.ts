import { expect } from "bun:test"
import { existsSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

export async function waitFor(file: string, worker: ReturnType<typeof startWorker>): Promise<void> {
  const deadline = Date.now() + 5000
  while (!existsSync(file)) {
    if (worker.exitCode !== null) {
      throw new Error(
        `ownership worker exited before ${path.basename(file)}: ${await new Response(worker.stderr).text()}`,
      )
    }
    if (Date.now() > deadline)
      throw new Error(`ownership worker timed out waiting for ${path.basename(file)}`)
    await Bun.sleep(10)
  }
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
const [file, dir, mode] = process.argv.slice(2)
const mark = (name: string, data: unknown = {}) => {
  const file = path.join(dir, name)
  writeFileSync(file + ".tmp", JSON.stringify(data))
  renameSync(file + ".tmp", file)
}
const wait = async (name: string) => {
  const deadline = Date.now() + 5000
  while (!existsSync(path.join(dir, name))) {
    if (Date.now() > deadline) throw new Error("worker protocol timed out: " + name)
    await Bun.sleep(10)
  }
}
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
  // Only this test's exact subprocess is killed if protocol cleanup did not let it exit.
  let timer: ReturnType<typeof setTimeout> | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      worker.exited,
      new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => {
          try {
            worker.kill()
            resolve()
          } catch (error) {
            reject(error)
          }
        }, 1000)
      }),
    ])
    const code = await Promise.race([
      worker.exited,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("ownership worker did not exit after cleanup")), 1000)
      }),
    ])
    const stderr = await new Response(worker.stderr).text()
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  } finally {
    clearTimeout(timer)
    clearTimeout(deadline)
    rmSync(dir, { recursive: true, force: true })
  }
}
