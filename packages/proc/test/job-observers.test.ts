import { expect, test } from "bun:test"
import { type JobChange, JobRegistry } from "../src/index.ts"

test("job-local observers receive startup chunks and terminal snapshots independently of retention", () => {
  const changes: JobChange[] = []
  const snapshots: string[] = []
  const registry = new JobRegistry({
    bufferChars: 1000,
    keepEnded: 0,
    start(_spec, emit) {
      emit({ type: "spawned", pid: 1, contained: true })
      emit({ type: "output", data: `READY${"x".repeat(2000)}` })
      emit({ type: "output", data: "\n" })
      emit({ type: "exit", code: 3, signal: null })
      return { stop() {} }
    },
  })
  registry.subscribe(({ type, job }) => {
    if (type === "output") snapshots.push(registry.output(job.id).text)
  })
  const ended = registry.start({
    command: "watch",
    argv: [],
    cwd: process.cwd(),
    kind: "monitor",
    onChange: (change) => changes.push(change),
  })
  expect(registry.get(ended.id)).toBeUndefined()
  expect(changes.map((c) => c.type)).toEqual(["start", "status", "output", "output", "end"])
  expect(
    changes
      .filter((c) => c.type === "output")
      .map((c) => c.output)
      .join(""),
  ).toBe(`READY${"x".repeat(2000)}\n`)
  expect(changes.at(-1)?.job).toMatchObject({ status: "exited", exitCode: 3, kind: "monitor" })
  // Subscribers can consume raw chunks while normal output reads keep their bounded contract.
  expect(snapshots.every((text) => !text.includes("READY"))).toBe(true)
})

test("a throwing per-job observer cannot disrupt lifecycle or other subscribers", () => {
  const types: string[] = []
  const registry = new JobRegistry({
    start() {
      throw new Error("startup failed")
    },
  })
  registry.subscribe(({ type }) => types.push(type))
  const job = registry.start({
    command: "missing",
    argv: [],
    cwd: process.cwd(),
    onChange() {
      throw new Error("observer failed")
    },
  })
  expect(job).toMatchObject({ status: "failed", error: "startup failed" })
  expect(types).toEqual(["start", "end"])
})
