import type { Schema, SchemaType } from "../../src/remote/schema/base.ts"
import type { SchemaPaths } from "../../src/remote/schema/shape.ts"

// Numeric bounds/constants may narrow a public number (e.g. v1 peer limits). Numeric
// literal unions still need every member; a broad schema cannot widen a literal TS type.
type Missing<A, B> = A extends B
  ? never
  : A extends `${infer P}:number=${infer N extends number}`
    ? number extends N
      ? Extract<B, `${P}:number=${number}`> extends never
        ? A
        : never
      : A
    : A
export type Difference<S extends Schema, T> =
  | Missing<SchemaPaths<SchemaType<S>>, SchemaPaths<T>>
  | Missing<SchemaPaths<T>, SchemaPaths<SchemaType<S>>>
  | (SchemaType<S> extends T ? never : "$:schema output is not assignable to the DTO")
export type AssertNone<T extends never> = T
