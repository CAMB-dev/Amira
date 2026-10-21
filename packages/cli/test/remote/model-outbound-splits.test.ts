import "../server/offline.ts"
import { expect, test } from "bun:test"
import { ModelOutboundError } from "../../src/remote/model-codec.ts"
import { ModelOutboundFilter, type ModelOutboundItem } from "../../src/remote/model-outbound-filter.ts"
import { type FieldCase, fieldCases, inject } from "./model-outbound-fields.ts"
import { identity, OutboundObserver } from "./model-outbound-observer.ts"
import { credentialSources } from "./model-outbound-sources.ts"

/** Factor field/representation coverage from split/lane coverage instead of multiplying them. */
test("all approved credential representations stay masked across structured outbound field/lane splits", () => {
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

  const text = fields.find((field) => field.name === "event:text.delta:text")!
  const thinking = fields.find((field) => field.name === "event:thinking.delta:text")!
  const tool = fields.find((field) => field.name === "event:toolCall.delta:argsDelta")!
  const lanes = [text, thinking, tool]
  expect(lanes.every(Boolean)).toBe(true)
  let rows = 0
  let rejected = 0
  let representation = 0
  for (const source of sources) {
    const observer = new OutboundObserver(source.secrets)
    function check(input: ModelOutboundItem[], output: ModelOutboundItem[], complete = true): void {
      if (
        (complete && output.length !== input.length) ||
        output.length > input.length ||
        output.some((item, index) => identity(item) !== identity(input[index]!))
      )
        throw new Error("Outbound filter dropped, reordered, or changed a schema-owned event")
      observer.reset()
      for (const item of output) observer.observe(item)
    }
    function row(
      variant: string,
      split: number,
      left: FieldCase,
      right: FieldCase,
      parent?: ModelOutboundFilter,
      committed: ModelOutboundItem[] = [],
    ): void {
      const prefix = variant.slice(0, split)
      const suffix = variant.slice(split)
      const input = [inject(left, prefix), inject(right, suffix)]
      const output = [...committed]
      const filter = parent?.fork() ?? new ModelOutboundFilter(source.secrets)
      try {
        try {
          if (!parent) output.push(...filter.push(input[0]!))
          output.push(...filter.push(input[1]!), ...filter.flush())
        } catch (error) {
          // Immutable accounting scalars and split dictionary keys may fail closed, but
          // must never silently drop/reorder items or publish a reconstructible credential.
          if (
            !(error instanceof ModelOutboundError) ||
            (!error.immutableScalar && (!(left.ref.key || right.ref.key) || !prefix || !suffix))
          )
            throw error
          check(input, output, false)
          filter.discard()
          rejected++
          return
        }
        check(input, output)
      } catch (error) {
        throw new Error(
          `${source.name}; ${JSON.stringify(variant)} split ${split}/${variant.length}; ${left.name} → ${right.name}`,
          { cause: error },
        )
      } finally {
        rows++
      }
    }
    for (const variant of source.variants) {
      // Every representation reaches every field intact and at an internal split.
      // A rotating permutation exercises every field in both positions, including keys,
      // with different cross-kind partners. No RNG or machine-dependent worker pool.
      for (const [index, field] of fields.entries()) {
        row(variant, variant.length, field, text)
        const split = variant.length > 1 ? 1 + ((index + representation) % (variant.length - 1)) : 0
        row(variant, split, field, fields[(index + representation + 1) % fields.length]!)
      }
      representation++

      // Exhaust every byte boundary, including empty prefix/suffix, on all ordered delta
      // lane pairs. Escapes, URL encoding and base64 padding get real split coverage.
      for (let split = 0; split <= variant.length; split++) {
        for (const left of lanes) for (const right of lanes) row(variant, split, left, right)
        const prefix = variant.slice(0, split)
        const suffix = variant.slice(split)
        const flushed = new ModelOutboundFilter(source.secrets)
        const before = inject(text, prefix)
        const after = inject(thinking, suffix)
        check(
          [before, after],
          [...flushed.push(before), ...flushed.flush(), ...flushed.push(after), ...flushed.flush()],
        )
        const interleaved = new ModelOutboundFilter(source.secrets)
        const input = [inject(text, prefix), inject(thinking, "unrelated"), inject(text, suffix)]
        check(input, [...input.flatMap((item) => interleaved.push(item)), ...interleaved.flush()])
      }

      // A committed metadata tail seeds independent calls in both text lanes at every boundary.
      for (let split = 0; split <= variant.length; split++) {
        for (const field of fields.filter((field) => field.kind === "metadata")) {
          const parent = new ModelOutboundFilter(source.secrets)
          const head = inject(field, variant.slice(0, split))
          let first: ModelOutboundItem[]
          try {
            first = [...parent.push(head), ...parent.flush()]
          } catch (error) {
            if (!(error instanceof ModelOutboundError) || !error.immutableScalar) throw error
            check([head], [], false)
            parent.discard()
            continue
          }
          for (const destination of [text, thinking]) row(variant, split, field, destination, parent, first)
        }
      }
    }
  }
  expect(rows).toBeGreaterThan(0)
  // Keep fixture growth from silently recreating the multi-million-row CI workload.
  expect(rows).toBeLessThan(25_000)
  expect(rejected).toBeLessThan(rows)

  const abandoned = new ModelOutboundFilter(sources[0]!.secrets)
  abandoned.push(inject(text, sources[0]!.variants[0]!.slice(0, 1)))
  abandoned.discard()
  expect(abandoned.flush()).toEqual([])
  const filter = new ModelOutboundFilter(secrets)
  const safe: ModelOutboundItem = { kind: "event", value: { type: "text.delta", text: "safe answer" } }
  expect([...filter.push(safe), ...filter.flush()]).toEqual([safe])
}, 60_000)
