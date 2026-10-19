import { ModelOutboundError } from "../../src/remote/model-codec.ts"
import { ModelOutboundFilter, type ModelOutboundItem } from "../../src/remote/model-outbound-filter.ts"
import { type FieldCase, fieldCases, inject } from "./model-outbound-fields.ts"
import { identity, OutboundObserver } from "./model-outbound-observer.ts"
import type { CredentialSource } from "./model-outbound-sources.ts"

declare const self: Worker

export interface SplitJob {
  source: CredentialSource
  variant: string
  split: number
}
export type SplitReply = { rows: number; rejected: number } | { error: string }
const fields = fieldCases()
const text = fields.find((field) => field.name === "event:text.delta:text")!
const thinking = fields.find((field) => field.name === "event:thinking.delta:text")!
const metadata = fields.filter((field) => field.kind === "metadata")

/** Each worker executes disjoint rows of the same matrix, not independent test cases. */
function run({ source, variant, split }: SplitJob): SplitReply {
  const prefix = variant.slice(0, split)
  const suffix = variant.slice(split)
  const observer = new OutboundObserver(source.secrets)
  let rows = 0
  let rejected = 0

  function check(input: ModelOutboundItem[], output: ModelOutboundItem[], complete = true): void {
    if (
      (complete && output.length !== input.length) ||
      output.length > input.length ||
      output.some((item, index) => identity(item) !== identity(input[index]!))
    )
      throw new Error(
        "Outbound filter dropped, reordered, or changed a schema-owned event instead of masking its payload",
      )
    observer.reset()
    for (const item of output) observer.observe(item)
  }

  function row(
    left: FieldCase,
    right: FieldCase,
    parent?: ModelOutboundFilter,
    committed: ModelOutboundItem[] = [],
  ): void {
    const filter = parent?.fork() ?? new ModelOutboundFilter(source.secrets)
    const input = [inject(left, prefix), inject(right, suffix)]
    const output: ModelOutboundItem[] = [...committed]
    try {
      if (!parent) output.push(...filter.push(input[0]!))
      output.push(...filter.push(input[1]!), ...filter.flush())
    } catch (error) {
      // Cross-field keys and immutable numeric/accounting observations cannot be rewritten.
      // Those rows must become sanitized incomplete terminals (covered by real-proxy tests),
      // never silently dropped. Non-secret controls still pass byte-for-byte unchanged.
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
  }

  for (const left of fields) {
    for (const right of fields) {
      try {
        row(left, right)
        rows++
      } catch (error) {
        throw new Error(
          `${source.name}; ${JSON.stringify(variant)} split ${split}/${variant.length}; ${left.name} → ${right.name}`,
          { cause: error },
        )
      }
    }
  }

  // A flush commits a prefix but must retain its audit tail for a later push.
  const flushed = new ModelOutboundFilter(source.secrets)
  const before = inject(text, prefix)
  const after = inject(thinking, suffix)
  check(
    [before, after],
    [...flushed.push(before), ...flushed.flush(), ...flushed.push(after), ...flushed.flush()],
  )

  // Both chronology and an individual lane with unrelated interleaving are observable.
  const interleaved = new ModelOutboundFilter(source.secrets)
  const input = [inject(text, prefix), inject(thinking, "unrelated"), inject(text, suffix)]
  check(input, [...input.flatMap((item) => interleaved.push(item)), ...interleaved.flush()])

  // All metadata/field pairs are in the matrix above. This additional lifecycle control
  // checks that a one-shot snapshot's committed tail reaches both call text lanes.
  for (const field of metadata) {
    const parent = new ModelOutboundFilter(source.secrets)
    const head = inject(field, prefix)
    let first: ModelOutboundItem[]
    try {
      first = [...parent.push(head), ...parent.flush()]
    } catch (error) {
      if (!(error instanceof ModelOutboundError) || !error.immutableScalar) throw error
      // Required metadata numbers can complete a prefix before a call even starts.
      check([head], [], false)
      parent.discard()
      rejected++
      continue
    }
    for (const destination of [text, thinking]) row(field, destination, parent, first)
  }
  return { rows, rejected }
}

self.onmessage = ({ data }: MessageEvent<SplitJob>) => {
  try {
    self.postMessage(run(data))
  } catch (error) {
    const messages: string[] = []
    let cause = error
    while (cause instanceof Error) {
      messages.push(cause.stack ?? cause.message)
      cause = cause.cause
    }
    self.postMessage({ error: messages.join("\nCaused by: ") } satisfies SplitReply)
  }
}
