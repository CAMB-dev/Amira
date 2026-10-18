import type { RemoteJson } from "../protocol.ts"

// Serde shape, independent of schema definitions: readonly is irrelevant to JSON, while
// field presence, optionality, variants and nested shapes must remain distinguishable.
type Scalar = string | number | boolean | null
type Tags = ["v", "type", "kind", "role", "op", "state", "status", "ok"]
type Literal<T> = T extends Scalar ? (string extends T ? never : number extends T ? never : T) : never
type Optional<T, K extends keyof T> = Record<never, never> extends Pick<T, K> ? true : false
type Refine<T, K extends keyof T, V> = Omit<T, K> &
  (Optional<T, K> extends true ? { [P in K]?: V } : { [P in K]: V })
type Expand<
  T,
  P extends string,
  K extends keyof T & string,
  R extends string[],
  Exact extends boolean,
  V = Exclude<T[K], undefined>,
> = V extends Scalar ? TagPaths<Refine<T, K, V>, `${P}[${K}=${V}]`, R, Exact> : never
type TagPaths<T, P extends string, L extends string[], Exact extends boolean> = L extends [
  infer K extends string,
  ...infer R extends string[],
]
  ? K extends keyof T
    ? [Literal<Exclude<T[K], undefined>>] extends [never]
      ? TagPaths<T, P, R, Exact>
      : Expand<T, P, K, R, Exact>
    : TagPaths<T, P, R, Exact>
  : Fields<T, P, Exact>
type FieldPaths<T, P extends string, Exact extends boolean> = string extends keyof T
  ? [T[string]] extends [never]
    ? never
    : Paths<T[string], `${P}.*`, Exact>
  : {
      [K in keyof T & string]-?:
        | `${P}.${K}${Optional<T, K> extends true ? "?" : "!"}`
        | Paths<Exclude<T[K], undefined>, `${P}.${K}`, Exact>
    }[keyof T & string]
type NumericShape<T> = T extends `${infer P}:number=${number}` ? `${P}:number` : T
type Signature<T, Exact extends boolean> = Exact extends true ? T : NumericShape<T>
type FieldSignature<T, P extends string, Exact extends boolean> = Signature<FieldPaths<T, P, Exact>, Exact>
type Fields<T, P extends string, Exact extends boolean> =
  | `${P}:object`
  | FieldPaths<T, P, Exact>
  | {
      readonly object: P
      // Invariant per-variant membership prevents an untagged sibling from masking a field.
      readonly fields: (field: FieldSignature<T, P, Exact>) => FieldSignature<T, P, Exact>
    }
type ItemSignature<T, P extends string, Exact extends boolean> = Signature<Paths<T, `${P}[]`, Exact>, Exact>
type Items<T, P extends string, Exact extends boolean> =
  | `${P}:array`
  | Paths<T, `${P}[]`, Exact>
  | {
      readonly array: P
      // Homogeneous-array unions must not pretend to accept mixed-element arrays.
      readonly items: (item: ItemSignature<T, P, Exact>) => ItemSignature<T, P, Exact>
    }
type Paths<T, P extends string, Exact extends boolean> = unknown extends T
  ? `${P}:opaque`
  : [RemoteJson] extends [T]
    ? `${P}:opaque`
    : T extends null
      ? `${P}:null`
      : T extends string
        ? string extends T
          ? `${P}:string`
          : `${P}=${T}`
        : T extends number
          ? `${P}:number=${T}`
          : T extends boolean
            ? `${P}=${T}`
            : T extends readonly (infer V)[]
              ? Items<V, P, Exact>
              : T extends object
                ? string extends keyof T
                  ? Fields<T, P, Exact>
                  : TagPaths<T, P, Tags, Exact>
                : never

/** DTO parity permits numeric bounds/constants under a public number. */
export type SchemaPaths<T, P extends string = "$"> = Paths<T, P, false>
/** An annotation must retain the exact inferred definition, including numeric enum members. */
export type DefinitionShape<T> = Paths<T, "$", true>
