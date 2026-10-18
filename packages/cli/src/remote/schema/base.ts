import type { RemoteJson } from "../protocol.ts"
import type { DefinitionShape } from "./shape.ts"

declare const untypedSchema: unique symbol
/** A type-only brand: raw ASTs and object spreads cannot masquerade as inferred definitions. */
declare class Definition<T> {
  private readonly data: T
  private readonly shape: (definition: DefinitionShape<T>) => DefinitionShape<T>
}
/** Retained only by TypeScript: no conversion hooks or metadata are added to wire schemas. */
export type SchemaType<S> = S extends Definition<infer T> ? T : unknown
export type Schema<T = typeof untypedSchema> = SchemaShape &
  ([T] extends [typeof untypedSchema]
    ? [typeof untypedSchema] extends [T]
      ? object
      : Definition<T>
    : Definition<T>)
// Without object, an all-optional mapped intersection can also admit primitive values.
type ObjectType<P extends Record<string, Schema>> = object & {
  [K in keyof P as K extends `${string}?` ? never : K]: SchemaType<P[K]>
} & {
  [K in keyof P as K extends `${infer Name}?` ? Name : never]?: SchemaType<P[K]>
}

/** Only closed DTO objects use object(); dictionaries opt in to explicitly typed values. */
interface SchemaShape {
  readonly type?: "object" | "array" | "string" | "integer" | "number" | "boolean" | "null"
  readonly enum?: readonly (string | number | boolean | null)[]
  readonly properties?: Readonly<Record<string, Schema>>
  readonly required?: readonly string[]
  readonly additionalProperties?: false | Schema
  readonly items?: Schema
  readonly minItems?: number
  readonly maxItems?: number
  readonly minLength?: number
  readonly maxLength?: number
  readonly pattern?: string
  readonly minimum?: number
  readonly maximum?: number
  readonly oneOf?: readonly Schema[]
  readonly anyOf?: readonly Schema[]
}
const constraintKeys = [
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
] as const

// The trusted builder kernel creates only plain JSON; its brand records the shape inferred
// from actual inputs. Callers cannot supply an expected DTO type to hide missing fields.
function typed<T>(schema: SchemaShape): Schema<T> {
  return schema as Schema<T>
}
export const text = typed<string>({ type: "string" })
export const number = typed<number>({ type: "number" })
export const bool = typed<boolean>({ type: "boolean" })
export const nil = typed<null>({ type: "null" })
export const integer = typed<number>({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
export const id = constrain(text, { minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_.:-]+$" })
/** Only opaque tool args/details and JSON Schema vocabulary use arbitrary finite JSON. */
export const json = typed<RemoteJson>({})
export const enumeration = <const V extends readonly (string | number | boolean | null)[]>(
  ...values: V
): Schema<V[number]> => typed<V[number]>({ enum: values })
export const union = <const S extends readonly Schema[]>(...schemas: S): Schema<SchemaType<S[number]>> =>
  typed<SchemaType<S[number]>>({ anyOf: [...schemas] })
export const exclusive = <const S extends readonly Schema[]>(...schemas: S): Schema<SchemaType<S[number]>> =>
  typed<SchemaType<S[number]>>({ oneOf: [...schemas] })
export const array = <S extends Schema>(items: S): Schema<SchemaType<S>[]> =>
  typed<SchemaType<S>[]>({ type: "array", items })
export const record = <S extends Schema>(values: S): Schema<Record<string, SchemaType<S>>> =>
  typed<Record<string, SchemaType<S>>>({ type: "object", additionalProperties: values })

/** Add value constraints without permitting callers to replace fields or union members. */
export function constrain<S extends Schema>(
  schema: S,
  bounds: Pick<SchemaShape, (typeof constraintKeys)[number]>,
): Schema<SchemaType<S>> {
  const selected = Object.fromEntries(
    constraintKeys.flatMap((key) => (bounds[key] === undefined ? [] : [[key, bounds[key]]])),
  )
  return typed<SchemaType<S>>({ ...schema, ...selected })
}
export function object<const P extends Record<string, Schema>>(properties: P): Schema<ObjectType<P>> {
  const entries = Object.entries(properties)
  return typed<ObjectType<P>>({
    type: "object",
    properties: Object.fromEntries(entries.map(([key, value]) => [key.replace(/\?$/, ""), value])),
    required: entries.filter(([key]) => !key.endsWith("?")).map(([key]) => key),
    additionalProperties: false,
  })
}

export function pickSchemas<const M extends Record<string, Record<F, Schema>>, F extends string>(
  definitions: M,
  field: F,
): { [K in keyof M]: M[K][F] } {
  return Object.fromEntries(Object.entries(definitions).map(([key, value]) => [key, value[field]])) as {
    [K in keyof M]: M[K][F]
  }
}

export function repeatSchema<const M extends Record<string, unknown>, S extends Schema>(
  definitions: M,
  schema: S,
): { [K in keyof M]: S } {
  return Object.fromEntries(Object.keys(definitions).map((key) => [key, schema])) as { [K in keyof M]: S }
}

type TaggedType<
  M extends Record<string, Schema>,
  Tag extends string,
  Value extends string,
  P extends Record<string, Schema>,
> = {
  [K in keyof M]: ObjectType<P> & { [F in Tag]: K } & { [F in Value]: SchemaType<M[K]> }
}[keyof M]
/** Keep each discriminator correlated with its child DTO, including through generated maps. */
export function taggedUnion<
  const M extends Record<string, Schema>,
  const Tag extends string,
  const Value extends string,
  const P extends Record<string, Schema>,
>(definitions: M, tag: Tag, valueKey: Value, properties: P): Schema<TaggedType<M, Tag, Value, P>> {
  return typed<TaggedType<M, Tag, Value, P>>({
    oneOf: Object.entries(definitions).map(([key, value]) =>
      object({ ...properties, [tag]: enumeration(key), [valueKey]: value }),
    ),
  })
}

export function matches(value: RemoteJson, schema: Schema): boolean {
  if (schema.oneOf && schema.oneOf.filter((item) => matches(value, item)).length !== 1) return false
  if (schema.anyOf && !schema.anyOf.some((item) => matches(value, item))) return false
  if (schema.enum && !schema.enum.some((item) => item === value)) return false
  switch (schema.type) {
    case "null":
      return value === null
    case "boolean":
      return typeof value === "boolean"
    case "string":
      return (
        typeof value === "string" &&
        (schema.minLength === undefined || value.length >= schema.minLength) &&
        (schema.maxLength === undefined || value.length <= schema.maxLength) &&
        (!schema.pattern || new RegExp(schema.pattern).test(value))
      )
    case "integer":
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (schema.type !== "integer" || Number.isSafeInteger(value)) &&
        (schema.minimum === undefined || value >= schema.minimum) &&
        (schema.maximum === undefined || value <= schema.maximum)
      )
    case "array":
      return (
        Array.isArray(value) &&
        (schema.minItems === undefined || value.length >= schema.minItems) &&
        (schema.maxItems === undefined || value.length <= schema.maxItems) &&
        value.every((item) => matches(item, schema.items ?? {}))
      )
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false
      if (schema.required?.some((key) => !Object.hasOwn(value, key))) return false
      return Object.entries(value).every(([key, item]) => {
        const property =
          schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined
        if (property) return matches(item, property)
        return schema.additionalProperties !== false && matches(item, schema.additionalProperties ?? {})
      })
    }
    default:
      return true
  }
}
