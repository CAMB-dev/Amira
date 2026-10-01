import { expect, setDefaultTimeout, test } from "bun:test"
import { resetCommandWorker, runCommand } from "../src/index.ts"

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
  expect(run.truncated).toBe(false)
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

test("a worker that fails to load falls back to running on this thread", async () => {
  resetCommandWorker({ url: new URL("./does-not-exist.ts", import.meta.url).href })
  try {
    const first = await runCommand([bun, "-e", "console.log('one')"], opts())
    const second = await runCommand([bun, "-e", "console.log('two')"], opts())
    expect(first.output.trim()).toBe("one")
    expect(second.output.trim()).toBe("two")
  } finally {
    resetCommandWorker()
  }
})

test("a process that only awaits a command stays alive until it finishes", async () => {
  const index = new URL("../src/index.ts", import.meta.url).href
  // Like the CLI: no top-level await (which alone keeps Bun running), so only the command can.
  const script = [
    `import(${JSON.stringify(index)}).then(async ({ runCommand }) => {`,
    `  const run = await runCommand([process.execPath, "-e", "await Bun.sleep(500); console.log('late')"], {`,
    "    cwd: process.cwd(), timeoutMs: 30_000, signal: new AbortController().signal })",
    "  console.log('result:' + run.output.trim())",
    "  console.log(JSON.stringify({ ...run, output: undefined }))",
    "})",
  ].join("\n")
  const child = Bun.spawn([bun, "-e", script], { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  // All of it on failure: whether Bun exited early (no result) or the command itself failed.
  const lines = out.trim().split(/\r?\n/)
  const ok = code === 0 && lines[0] === "result:late"
  expect({ code, result: lines[0], ...(ok ? {} : { err }) }).toEqual({ code: 0, result: "result:late" })
  expect(JSON.parse(lines[1]!)).toMatchObject({ exitCode: 0, timedOut: false, aborted: false })
})

test("a failing chunk callback does not break the run", async () => {
  const run = await runCommand([bun, "-e", "console.log('x')"], {
    ...opts(),
    onChunk: () => {
      throw new Error("boom")
    },
  })
  expect(run.exitCode).toBe(0)
})

test("without maxOutputChars the output is not capped", async () => {
  const run = await runCommand([bun, "-e", "process.stdout.write('x'.repeat(1_000_000) + 'END')"], opts())
  expect(run.output.length).toBe(1_000_003)
  expect(run.truncated).toBe(false)
})

test("maxOutputChars overrides the cap; chunks still carry all output", async () => {
  let streamed = 0
  const run = await runCommand([bun, "-e", "process.stdout.write('x'.repeat(200_000) + 'END')"], {
    ...opts(),
    maxOutputChars: 10,
    onChunk: (c) => {
      streamed += c.length
    },
  })
  expect(run.output).toBe("xxxxxxxEND")
  expect(run.truncated).toBe(true)
  expect(streamed).toBe(200_003)
})

test("the output cap does not split a UTF-16 surrogate pair", async () => {
  const run = await runCommand([bun, "-e", "process.stdout.write('a😀tail')"], {
    ...opts(),
    maxOutputChars: 5,
  })
  expect(run.output).toBe("tail")
  expect(run.truncated).toBe(true)
})

test("maxOutputChars rejects invalid values", async () => {
  for (const maxOutputChars of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(runCommand([bun, "-e", ""], { ...opts(), maxOutputChars })).rejects.toThrow(
      "maxOutputChars must be a positive integer",
    )
  }
})
