import "../server/offline.ts"
import { expect, test } from "bun:test"
import {
  array,
  bool,
  enumeration,
  matches,
  number,
  object,
  record,
  taggedUnion,
  text,
  union,
} from "../../src/remote/schema/base.ts"
import type { AssertNone, Difference } from "./schema-parity-types.ts"

const complete = object({ name: text, "note?": text, rows: array(object({ name: text, "enabled?": bool })) })
type Complete = { name: string; note?: string; rows: { name: string; enabled?: boolean }[] }
export type GoodParityProof = AssertNone<Difference<typeof complete, Complete>>
const missing = object({ name: text, rows: array(object({ name: text })) })
// @ts-expect-error Optional fields and nested array-item fields must not disappear from a closed schema.
export type MissingFieldProof = AssertNone<Difference<typeof missing, Complete>>
const extra = object({ name: text, "unexpected?": bool })
// @ts-expect-error A field added only to the schema must also fail parity.
export type ExtraFieldProof = AssertNone<Difference<typeof extra, { name: string }>>
const required = object({ name: text, note: text })
// @ts-expect-error Requiredness is part of the DTO, not only its key names.
export type RequirednessProof = AssertNone<Difference<typeof required, { name: string; note?: string }>>
const wrongType = object({ name: bool })
// @ts-expect-error Scalar types must not drift.
export type FieldTypeProof = AssertNone<Difference<typeof wrongType, { name: string }>>
const wrongEnum = object({ state: enumeration("active", "ended") })
// @ts-expect-error New enum values cannot silently widen the contract.
export type EnumProof = AssertNone<Difference<typeof wrongEnum, { state: "active" }>>
const numericEnum = object({ mode: enumeration(1) })
// @ts-expect-error Every numeric enum member must be represented, not only some member.
export type NumericEnumProof = AssertNone<Difference<typeof numericEnum, { mode: 1 | 2 }>>
const wideNumeric = object({ mode: number })
// @ts-expect-error A broad numeric schema cannot widen a literal TS value.
export type NumericWideningProof = AssertNone<Difference<typeof wideNumeric, { mode: 1 }>>
export type NumericNarrowingProof = AssertNone<Difference<typeof numericEnum, { mode: number }>>
const swapped = union(
  object({ kind: enumeration("a"), value: object({ right: text }) }),
  object({ kind: enumeration("b"), value: object({ left: text }) }),
)
type SwappedDifference = Difference<
  typeof swapped,
  { kind: "a"; value: { left: string } } | { kind: "b"; value: { right: string } }
>
// @ts-expect-error Identical aggregate union keys do not excuse fields on the wrong discriminator branch.
export type CorrelatedUnionProof = AssertNone<SwappedDifference>
const dictionary = record(object({ name: text }))
type DictionaryDifference = Difference<typeof dictionary, Record<string, { name: string; note?: string }>>
// @ts-expect-error Typed dictionary values have nested closed DTOs too.
export type DictionaryProof = AssertNone<DictionaryDifference>
const tagMap = taggedUnion({ a: object({ left: text }), b: object({ right: text }) }, "kind", "value", {
  version: enumeration(1),
})
export type TaggedMapProof = AssertNone<
  Difference<
    typeof tagMap,
    { version: 1; kind: "a"; value: { left: string } } | { version: 1; kind: "b"; value: { right: string } }
  >
>

test("schema inference retains runtime closure without adding phantom metadata to JSON", () => {
  expect(complete.required).toEqual(["name", "rows"])
  expect(Object.getOwnPropertySymbols(complete)).toEqual([])
  expect(matches({ name: "name", rows: [{ name: "row", enabled: true }] }, complete)).toBe(true)
  expect(matches({ name: "name", rows: [{ name: "row", unexpected: true }] }, complete)).toBe(false)
  expect(matches({ version: 1, kind: "a", value: { left: "ok" } }, tagMap)).toBe(true)
  expect(matches({ version: 1, kind: "a", value: { right: "wrong" } }, tagMap)).toBe(false)
})
