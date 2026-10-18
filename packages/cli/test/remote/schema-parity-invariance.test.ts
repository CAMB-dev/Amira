import "../server/offline.ts"
import { expect, test } from "bun:test"
import type { ToolResult } from "@amira/api"
import {
  array,
  bool,
  constrain,
  enumeration,
  json,
  matches,
  object,
  type Schema,
  text,
  union,
} from "../../src/remote/schema/base.ts"
import { imageBlock, textBlock, toolResult } from "../../src/remote/schema/messages.ts"
import type { AssertNone, Difference } from "./schema-parity-types.ts"

type Untagged = { left: string; shared?: boolean } | { right: string; shared?: boolean }
const missingOnOneBranch = union(object({ left: text }), object({ right: text, "shared?": bool }))
// @ts-expect-error The right sibling cannot mask a field missing from the left variant.
export type UntaggedOmission = AssertNone<Difference<typeof missingOnOneBranch, Untagged>>
const extraOnOtherAnswer = union(
  object({ other: text, "key?": text }),
  object({ option: text, "key?": text }),
)
type OtherAnswerDifference = Difference<
  typeof extraOnOtherAnswer,
  { other: string } | { option: string; key?: string }
>
// @ts-expect-error SelectChoice's key cannot legitimize a schema-only key on the Other answer.
export type UntaggedAddition = AssertNone<OtherAnswerDifference>
const swapped = union(
  object({ variant: enumeration("a"), value: object({ right: text }) }),
  object({ variant: enumeration("b"), value: object({ left: text }) }),
)
type UntaggedDifference = Difference<
  typeof swapped,
  { variant: "a"; value: { left: string } } | { variant: "b"; value: { right: string } }
>
// @ts-expect-error Arbitrary discriminators must not depend on a hard-coded tag vocabulary.
export type UntaggedCorrelation = AssertNone<UntaggedDifference>

const homogeneous = object({ items: union(array(text), array(bool)) })
type ArrayDifference = Difference<typeof homogeneous, { items: (string | boolean)[] }>
// @ts-expect-error Per-array variants cannot pool item paths and pretend to accept mixed arrays.
export type ArrayMembership = AssertNone<ArrayDifference>
const numeric = object({ mode: enumeration(1) })
export type NumericConstraint = AssertNone<Difference<typeof numeric, { mode: number }>>
// @ts-expect-error An annotation cannot invent a missing numeric enum member.
export const hiddenEnumMember: Schema<{ mode: 1 | 2 }> = numeric

const incomplete = object({
  content: array(union(textBlock, imageBlock)),
  "isError?": bool,
  "details?": json,
})
// @ts-expect-error An explicit annotation must not erase the omitted persistDetails field.
export const hiddenOmission: Schema<ToolResult> = incomplete
const extra = object({
  content: array(union(textBlock, imageBlock)),
  "isError?": bool,
  "details?": json,
  "persistDetails?": bool,
  "schemaOnly?": bool,
})
// @ts-expect-error Nor may an annotation erase a field present only in the schema.
export const hiddenAddition: Schema<ToolResult> = extra
const nested = object({ rows: array(object({ name: text })) })
// @ts-expect-error Exactness applies to nested array items as well as the outer DTO.
export const hiddenNested: Schema<{ rows: { name: string; note?: string }[] }> = nested
export const validAnnotation: Schema<ToolResult> = toolResult
// @ts-expect-error Raw ASTs cannot claim a DTO type without inference through the builder kernel.
export const rawAnnotation: Schema<ToolResult> = { type: "object", properties: {} }
const alteredClone = { ...toolResult, properties: { content: array(union(textBlock, imageBlock)) } }
type CloneDifference = Difference<typeof alteredClone, ToolResult>
// @ts-expect-error Spreading an AST must not copy its private inference brand and hide altered fields.
export type AlteredClone = AssertNone<CloneDifference>
export function cannotMutate(schema: Schema<ToolResult>) {
  // @ts-expect-error Definitions cannot be mutated behind the inferred type.
  schema.properties = {}
}

test("definition exactness is type-only and never adds phantom fields to JSON", () => {
  expect(Object.getOwnPropertySymbols(validAnnotation)).toEqual([])
  expect(matches("long", constrain(text, { maxLength: 2 }))).toBe(false)
  const constrained = constrain(toolResult, { maxLength: 2, properties: {} } as never)
  expect(constrained.properties).toEqual(toolResult.properties)
  expect(Object.keys(validAnnotation.properties ?? {}).sort()).toEqual([
    "content",
    "details",
    "isError",
    "persistDetails",
  ])
})
