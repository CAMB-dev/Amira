import { expect, setDefaultTimeout, test } from "bun:test"
import { runCommand } from "../src/index.ts"

// Spawns can take seconds on Windows machines with antivirus scanning.
setDefaultTimeout(60_000)

const bun = process.execPath
const opts = (signal = new AbortController().signal) => ({ cwd: process.cwd(), timeoutMs: 30_000, signal })

test("runs a command in the worker and streams its output in chunks", async () => {
  const chunks: string[] = []
  const run = await runCommand([bun, "-e", "console.log('out'); console.error('err'); process.exit(3)"], {
    ...opts(),
    onChunk: (c) => void chunks.push(c),
  })
  expect(run.exitCode).toBe(3)
  expect(run.output).toContain("out")
  expect(run.output).toContain("err")
  expect(chunks.join("")).toBe(run.output)
})

test("stdoutOnly drops stderr", async () => {
  const run = await runCommand([bun, "-e", "console.log('out'); console.error('err')"], {
    ...opts(),
    stdoutOnly: true,
  })
  expect(run.output.trim()).toBe("out")
})

test("abort reaches the worker and kills the command", async () => {
  const abort = new AbortController()
  const started = performance.now()
  const p = runCommand([bun, "-e", "setTimeout(() => {}, 60_000)"], opts(abort.signal))
  setTimeout(() => abort.abort(), 500)
  const run = await p
  expect(run.aborted).toBe(true)
  expect(performance.now() - started).toBeLessThan(30_000)
})

test("the main thread keeps running while a command runs", async () => {
  let ticks = 0
  const id = setInterval(() => ticks++, 10)
  await runCommand([bun, "-e", "Bun.sleepSync(300)"], opts())
  clearInterval(id)
  expect(ticks).toBeGreaterThan(10)
})
