import "../server/offline.ts"
import { expect, test } from "bun:test"
import { constants, setPriority } from "node:os"
import path from "node:path"
import { ModelOutboundFilter, type ModelOutboundItem } from "../../src/remote/model-outbound-filter.ts"
import { fieldCases, inject } from "./model-outbound-fields.ts"
import { credentialSources } from "./model-outbound-sources.ts"
import type { SplitJob } from "./model-outbound-split-worker.ts"

/** One logical matrix: source × representation × every split × every ordered field pair. */
test("all approved credential representations stay masked across every outbound field/lane split", async () => {
  const fields = fieldCases()
  const sources = credentialSources()
  expect(new Set(fields.map((field) => field.kind))).toEqual(
    new Set(["event", "compact", "receipt", "metadata"]),
  )
  for (const surface of [
    "request.end",
    "done",
    "error",
    "serverTool",
    "signature",
    "citations",
    "args",
    "(key)",
    "checkpoint",
    "summary",
    "tried",
    "serviceTier",
  ])
    expect(fields.some((field) => field.name.includes(surface))).toBe(true)

  // Every field, including dictionary keys, must pass a non-secret byte-for-byte control.
  // Together with ordered row identities this prevents an always-reject/drop implementation.
  const secrets = sources.flatMap((source) => [...source.secrets])
  for (const field of fields) {
    const filter = new ModelOutboundFilter(secrets)
    const input = inject(field, "safe answer")
    expect([...filter.push(input), ...filter.flush()]).toEqual([input])
  }

  const jobs: SplitJob[] = sources.flatMap((source) =>
    source.variants.flatMap((variant) =>
      Array.from({ length: variant.length + 1 }, (_, split) => ({ source, variant, split })),
    ),
  )
  const expectedRows = jobs.length * fields.length ** 2
  const child = Bun.spawn(
    [process.execPath, "--no-install", path.join(import.meta.dir, "model-outbound-split-driver.ts")],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  try {
    // Lower only the matrix process, not Bun's other per-file test VMs or their native
    // children. A start gate ensures all compute workers inherit this priority.
    setPriority(child.pid, constants.priority.PRIORITY_LOW)
    await child.stdin.write("run\n")
    await child.stdin.end()
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stderr).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.completed).toBe(jobs.length)
    expect(result.jobs).toBe(jobs.length)
    expect(result.expectedRows).toBe(expectedRows)
    expect(result.rows).toBe(expectedRows)
    expect(result.rows).toBeGreaterThan(0)
    expect(result.rejected).toBeLessThan(result.rows)
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited
  }

  const text = fields.find((field) => field.name === "event:text.delta:text")!
  const abandoned = new ModelOutboundFilter(sources[0]!.secrets)
  abandoned.push(inject(text, sources[0]!.variants[0]!.slice(0, 1)))
  abandoned.discard()
  expect(abandoned.flush()).toEqual([])
  const filter = new ModelOutboundFilter(secrets)
  const safe: ModelOutboundItem = { kind: "event", value: { type: "text.delta", text: "safe answer" } }
  expect([...filter.push(safe), ...filter.flush()]).toEqual([safe])
}, 900_000)
