import "../server/offline.ts"
import { expect, test } from "bun:test"
import type { ExtensionStatusMetadata } from "@amira/api"
import type { RemoteJson } from "../../src/remote/protocol.ts"
import {
  array,
  enumeration,
  matches,
  nil,
  object,
  type SchemaType,
  text,
  union,
} from "../../src/remote/schema/base.ts"
import type { AssertNone, Difference } from "./schema-parity-types.ts"

const metadata = object({
  "status?": enumeration("experimental", "wip", "deprecated"),
  "statusMessage?": text,
  "replacedBy?": text,
})
const badges = array(union(metadata, nil))
export type OptionalObjectParity = [
  AssertNone<Extract<string | number | boolean, SchemaType<typeof metadata>>>,
  AssertNone<Difference<typeof badges, (ExtensionStatusMetadata | null)[]>>,
]

test("all-optional objects retain their closed object shape inside nullable arrays", () => {
  expect(matches([{}, null, { status: "wip" }], badges)).toBe(true)
  const invalids: RemoteJson[] = ["wip", 1, true, [], { status: "stable" }, { unexpected: true }]
  for (const invalid of invalids) {
    expect(matches(invalid, metadata)).toBe(false)
    expect(matches([invalid], badges)).toBe(false)
  }
})
