import type { MarkdownRenderContext, MarkdownRenderResult } from "./render.ts"

export type ExtensionSettingValue = string | number | boolean
export type ExtensionSettingsScope = "user" | "project"

export interface ExtensionSettingOption {
  value: string
  label?: string
  description?: string
}

interface ExtensionSettingBase {
  /** A flat key in this extension's settings section, not a dotted path. */
  key: string
  label: string
  description?: string
}

export type ExtensionSettingsField = ExtensionSettingBase &
  (
    | { type: "number"; default: number; min?: number; max?: number; step?: number }
    | { type: "toggle"; default: boolean }
    | {
        type: "choice"
        default: string
        options: readonly (string | ExtensionSettingOption)[]
      }
    | {
        type: "text"
        default: string
        placeholder?: string
        pattern?: string
        /** Maximum Unicode code points; supplementary characters such as emoji count as one. */
        maxLength?: number
      }
    | { type: "colour"; default: string }
  )

/** One declared field; singular alias for frontends consuming page schemas. */
export type ExtensionSettingField = ExtensionSettingsField

type OptionValue<T> = T extends string ? T : T extends { value: infer V extends string } ? V : never

type FieldValue<F extends ExtensionSettingsField> = F extends { type: "number" }
  ? number
  : F extends { type: "toggle" }
    ? boolean
    : F extends { type: "choice"; options: readonly (infer O)[] }
      ? OptionValue<O>
      : string

/** Values inferred from field keys and types, including a choice's allowed values. */
export type ExtensionSettingsValues<
  F extends readonly ExtensionSettingsField[] = readonly ExtensionSettingsField[],
> = {
  readonly [Field in F[number] as Field["key"]]: FieldValue<Field>
}

export interface ExtensionSettingsPreviewContext extends MarkdownRenderContext {
  /** Aborts when this preview is replaced, closed, or its extension unloads. */
  signal: AbortSignal
}

export interface ExtensionSettingsDeclaration<
  F extends readonly ExtensionSettingsField[] = readonly ExtensionSettingsField[],
> {
  fields: F
  /**
   * Render an isolated draft using the same helpers as your real renderer. Only this callback
   * receives the draft; get() and other renderers continue to see the saved settings.
   */
  preview?(
    draft: ExtensionSettingsValues<F>,
    ctx: ExtensionSettingsPreviewContext,
  ): MarkdownRenderResult | Promise<MarkdownRenderResult>
}

export interface ExtensionSettingsHandle<
  F extends readonly ExtensionSettingsField[] = readonly ExtensionSettingsField[],
> {
  /** The current validated values, with defaults for missing or invalid settings. */
  get(): ExtensionSettingsValues<F>
  /** Called after saved values change; sync throws and async rejections are extension errors.
   * Returns a disposer; also disposed on unload.
   */
  onChange(fn: (values: ExtensionSettingsValues<F>) => void): () => void
}

/** The declared defaults, without reading settings or changing the live handle. */
export function extensionSettingsDefaults<F extends readonly ExtensionSettingsField[]>(
  fields: F,
): ExtensionSettingsValues<F> {
  return Object.freeze(
    Object.fromEntries(fields.map((field) => [field.key, field.default])),
  ) as ExtensionSettingsValues<F>
}

/** A validation problem for one field, or undefined when its value is valid. */
export function validateExtensionSetting(field: ExtensionSettingsField, value: unknown): string | undefined {
  switch (field.type) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a finite number"
      if (field.min !== undefined && value < field.min) return `must be at least ${field.min}`
      if (field.max !== undefined && value > field.max) return `must be at most ${field.max}`
      if (field.step !== undefined) {
        const steps = (value - (field.min ?? 0)) / field.step
        if (!Number.isFinite(steps) || Math.abs(steps - Math.round(steps)) > 1e-8)
          return `must use steps of ${field.step} from ${field.min ?? 0}`
      }
      return
    }
    case "toggle":
      return typeof value === "boolean" ? undefined : "must be true or false"
    case "choice":
      return field.options.some((option) => (typeof option === "string" ? option : option.value) === value)
        ? undefined
        : "must be one of the declared choices"
    case "colour":
      return typeof value === "string" && /^#[\da-f]{6}$/i.exec(value)?.[0] === value
        ? undefined
        : "must be a colour in #RRGGBB format"
    case "text":
      if (typeof value !== "string") return "must be a string"
      if (!value.isWellFormed()) return "must contain well-formed Unicode text"
      if (field.maxLength !== undefined && Array.from(value).length > field.maxLength)
        return `must have at most ${field.maxLength} characters`
      if (field.pattern !== undefined && new RegExp(`^(?:${field.pattern})$`).exec(value)?.[0] !== value)
        return "must match the declared pattern"
      return
  }
}
