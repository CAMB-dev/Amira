import path from "node:path"
import {
  type ExtensionSettingsDeclaration,
  type ExtensionSettingsField,
  type ExtensionSettingsHandle,
  type ExtensionSettingsPreviewContext,
  type ExtensionSettingsScope,
  type ExtensionSettingsValues,
  type ExtensionSettingValue,
  type ExtensionStatusMetadata,
  extensionSettingsDefaults,
  type MarkdownRenderResult,
  type Settings,
  type SettingsLayer,
  type SettingsLayers,
  type SettingsView,
  validateExtensionSetting,
} from "@amira/api"
import { extensionStatusMetadata } from "@amira/api/internal/extension-status"
import { loadSettings, type SettingsSources } from "./config/load.ts"
import { isPlainObject, UNSAFE_KEYS } from "./config/merge.ts"
import { SettingsError } from "./config/schema.ts"
import { updateSettingsFile } from "./config/write.ts"
import { amiraHome, projectAmiraDir } from "./home.ts"

type Values = Readonly<Record<string, ExtensionSettingValue>>
type SettingsListener = (values: Values) => unknown

/** Host-owned page data. The extension cannot choose its settings namespace or write scope. */
export interface ExtensionSettingsRegistration {
  readonly name: string
  readonly source: string
  readonly extensionStatus?: ExtensionStatusMetadata
  readonly fields: readonly ExtensionSettingsField[]
  get(): Values
  /** Explicit values for each field, lowest precedence first, including invalid values. */
  readonly sources: Readonly<Record<string, readonly SettingsLayer[]>>
  readonly defaultScope: ExtensionSettingsScope
  preview?(draft: Values, ctx: ExtensionSettingsPreviewContext): Promise<MarkdownRenderResult>
  /** Validates before writing, keeps unrelated keys, then reloads and notifies live handles. */
  save(values: Values, scope: ExtensionSettingsScope): Promise<void>
}

export interface ExtensionSettingsRegistryOptions {
  settings?: Settings
  layers?: SettingsLayers
  settingsSources: SettingsSources
  warning: (text: string) => void
  failure: (source: string, error: string) => void
  /** The CLI supplies its flag-aware loader; isolated hosts use loadSettings. */
  reloadSettings?: () => { settings: Settings; layers: SettingsLayers; warnings?: string[] }
  onReload?: (settings: Settings, layers: SettingsLayers) => void
}

interface Entry {
  registration: ExtensionSettingsRegistration
  values: Values
  sources: Readonly<Record<string, readonly SettingsLayer[]>>
  listeners: Set<SettingsListener>
  previews: Set<AbortController>
  active: boolean
}

/** Declarations and live validated values, owned by the host's extension identities. */
export class ExtensionSettingsRegistry {
  #entries = new Map<string, Entry>()
  #settings: Settings
  #layers: SettingsLayers

  constructor(private readonly opts: ExtensionSettingsRegistryOptions) {
    this.#settings = structuredClone(opts.settings ?? {})
    this.#layers = structuredClone(opts.layers ?? {})
  }

  list(): ExtensionSettingsRegistration[] {
    return [...this.#entries.values()].map((entry) => entry.registration)
  }

  has(name: string): boolean {
    return this.#entries.has(name)
  }

  get(name: string): ExtensionSettingsRegistration | undefined {
    return this.#entries.get(name)?.registration
  }

  register<const F extends readonly ExtensionSettingsField[]>(
    name: string,
    source: string,
    declaration: ExtensionSettingsDeclaration<F>,
    status?: ExtensionStatusMetadata,
  ): { handle: ExtensionSettingsHandle<F>; dispose: () => void } {
    if (!name || UNSAFE_KEYS.has(name)) throw new Error("Invalid extension settings identity")
    if (this.#entries.has(name)) throw new Error(`Settings already declared for ${name}`)
    validateDeclaration(declaration)
    const fields = freeze(structuredClone(declaration.fields))
    const preview = declaration.preview
    const state = this.#resolve(name, fields)
    let entry: Entry
    const ensureActive = () => {
      if (!entry.active) throw new Error(`Settings declaration for ${name} is unloaded`)
    }
    const registration: ExtensionSettingsRegistration = {
      name,
      source,
      ...(status ? { extensionStatus: freeze(extensionStatusMetadata(status)) } : {}),
      fields,
      get: () => entry.values,
      get sources() {
        return entry.sources
      },
      get defaultScope() {
        const scopes = Object.values(entry.sources)
          .flat()
          .map((layer) => layer.scope)
        return scopes.includes("project-local") || scopes.includes("project") ? "project" : "user"
      },
      ...(preview
        ? {
            preview: async (draft: Values, ctx: ExtensionSettingsPreviewContext) => {
              ensureActive()
              validateValues(name, fields, draft)
              ctx.signal.throwIfAborted()
              const abort = new AbortController()
              const onAbort = () => abort.abort()
              ctx.signal.addEventListener("abort", onAbort, { once: true })
              entry.previews.add(abort)
              try {
                const result = await preview(freeze(structuredClone(draft)) as ExtensionSettingsValues<F>, {
                  ...ctx,
                  theme: { ...ctx.theme },
                  signal: abort.signal,
                })
                abort.signal.throwIfAborted()
                return result
              } finally {
                ctx.signal.removeEventListener("abort", onAbort)
                entry.previews.delete(abort)
              }
            },
          }
        : {}),
      save: async (values, scope) => {
        ensureActive()
        validateValues(name, fields, values)
        const files: Record<ExtensionSettingsScope, string> = {
          user: path.join(this.opts.settingsSources.home ?? amiraHome(), "settings.json"),
          project: path.join(projectAmiraDir(this.opts.settingsSources.cwd), "settings.json"),
        }
        if (!Object.hasOwn(files, scope)) throw new Error("Invalid extension settings scope")
        updateSettingsFile(
          files[scope],
          (raw) => {
            const extensions = raw.extensions ?? {}
            if (!isPlainObject(extensions))
              throw new SettingsError(files[scope], ['"extensions" must be an object'])
            const current = Object.hasOwn(extensions, name) ? extensions[name] : {}
            if (!isPlainObject(current))
              throw new SettingsError(files[scope], [`"extensions.${name}" must be an object`])
            return { ...raw, extensions: { ...extensions, [name]: { ...current, ...values } } }
          },
          { preserveFormatting: true },
        )
        const loaded = this.opts.reloadSettings?.() ?? loadSettings(this.opts.settingsSources)
        for (const warning of loaded.warnings ?? []) this.opts.warning(warning)
        if (this.opts.onReload) this.opts.onReload(loaded.settings, loaded.layers)
        else this.setSettings(loaded.settings, loaded.layers)
      },
    }
    entry = { ...state, registration, listeners: new Set(), previews: new Set(), active: true }
    this.#entries.set(name, entry)
    return {
      handle: {
        get: () => entry.values as ExtensionSettingsValues<F>,
        onChange: (fn) => {
          ensureActive()
          const listener = fn as SettingsListener
          entry.listeners.add(listener)
          return () => void entry.listeners.delete(listener)
        },
      },
      dispose: () => {
        entry.active = false
        entry.listeners.clear()
        for (const abort of entry.previews) abort.abort()
        entry.previews.clear()
        if (this.#entries.get(name) === entry) this.#entries.delete(name)
      },
    }
  }

  setSettings(settings: Settings, layers: SettingsLayers = {}): void {
    this.#settings = structuredClone(settings)
    this.#layers = structuredClone(layers)
    // Resolve every declaration before notifying, so listeners see one coherent settings state.
    const changed: Entry[] = []
    for (const [name, entry] of this.#entries) {
      const state = this.#resolve(name, entry.registration.fields)
      if (JSON.stringify(entry.values) !== JSON.stringify(state.values)) changed.push(entry)
      Object.assign(entry, state)
    }
    for (const entry of changed) {
      const failure = (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.opts.failure(entry.registration.source, `settings change handler failed: ${message}`)
      }
      for (const listener of [...entry.listeners]) {
        if (!entry.active || !entry.listeners.has(listener)) continue
        try {
          void Promise.resolve(listener(entry.values)).catch(failure)
        } catch (error) {
          failure(error)
        }
      }
    }
  }

  #resolve(name: string, fields: readonly ExtensionSettingsField[]): Pick<Entry, "values" | "sources"> {
    const values: Record<string, ExtensionSettingValue> = { ...extensionSettingsDefaults(fields) }
    const sources: Record<string, readonly SettingsLayer[]> = {}
    const settings = this.#settings.extensions
    const raw = settings && Object.hasOwn(settings, name) ? settings[name] : {}
    for (const field of fields) {
      const layers = (this.#layers.extensions ?? []).flatMap((layer) => {
        if (!isPlainObject(layer.value)) return []
        const section = Object.hasOwn(layer.value, name) ? layer.value[name] : undefined
        if (!isPlainObject(section) || !Object.hasOwn(section, field.key)) return []
        return [{ scope: layer.scope, file: layer.file, value: section[field.key] }]
      })
      sources[field.key] = freeze(structuredClone(layers))
      const at = `extensions.${name}.${field.key}`
      for (const layer of layers) {
        const problem = validateExtensionSetting(field, layer.value)
        if (problem) this.opts.warning(`${layer.file}: "${at}" ${problem} (ignored)`)
      }
      if (!raw || !Object.hasOwn(raw, field.key)) continue
      const problem = validateExtensionSetting(field, raw[field.key])
      if (!problem) values[field.key] = raw[field.key] as ExtensionSettingValue
      else if (!layers.length) this.opts.warning(`settings: "${at}" ${problem} (ignored; using default)`)
    }
    return { values: freeze(values), sources: freeze(sources) }
  }
}

function validateValues(name: string, fields: readonly ExtensionSettingsField[], values: Values): void {
  if (!isPlainObject(values)) throw new Error("Extension settings values must be an object")
  for (const key of Object.keys(values)) {
    if (!fields.some((field) => field.key === key))
      throw new Error(`Unknown setting "extensions.${name}.${key}"`)
  }
  for (const field of fields) {
    const problem = validateExtensionSetting(
      field,
      Object.hasOwn(values, field.key) ? values[field.key] : undefined,
    )
    if (problem) throw new Error(`"extensions.${name}.${field.key}" ${problem}`)
  }
}

function validateDeclaration(
  declaration: ExtensionSettingsDeclaration<readonly ExtensionSettingsField[]>,
): void {
  if (!declaration || !Array.isArray(declaration.fields) || !declaration.fields.length)
    throw new Error("Extension settings must declare at least one field")
  if (declaration.preview !== undefined && typeof declaration.preview !== "function")
    throw new Error("Extension settings preview must be a function")
  const keys = new Set<string>()
  for (const field of declaration.fields) {
    if (!field || typeof field.key !== "string" || !/^[\w.-]+$/.test(field.key) || UNSAFE_KEYS.has(field.key))
      throw new Error("Invalid extension setting key")
    if (keys.has(field.key)) throw new Error(`Duplicate extension setting key "${field.key}"`)
    keys.add(field.key)
    if (typeof field.label !== "string" || !field.label.trim())
      throw new Error(`Setting "${field.key}" needs a label`)
    if (field.description !== undefined && typeof field.description !== "string")
      throw new Error(`Setting "${field.key}" description must be a string`)
    if (field.type === "number") {
      for (const key of ["min", "max", "step"] as const) {
        if (field[key] !== undefined && (typeof field[key] !== "number" || !Number.isFinite(field[key])))
          throw new Error(`Setting "${field.key}" ${key} must be a finite number`)
      }
      if (field.min !== undefined && field.max !== undefined && field.min > field.max)
        throw new Error(`Setting "${field.key}" min must not exceed max`)
      if (field.step !== undefined && field.step <= 0)
        throw new Error(`Setting "${field.key}" step must be positive`)
    } else if (field.type === "text") {
      if (field.placeholder !== undefined && typeof field.placeholder !== "string")
        throw new Error(`Setting "${field.key}" placeholder must be a string`)
      if (field.maxLength !== undefined && (!Number.isInteger(field.maxLength) || field.maxLength < 0))
        throw new Error(`Setting "${field.key}" maxLength must be a nonnegative integer`)
      if (field.pattern !== undefined) {
        if (typeof field.pattern !== "string")
          throw new Error(`Setting "${field.key}" pattern must be a string`)
        new RegExp(`^(?:${field.pattern})$`)
      }
    } else if (field.type === "choice") {
      if (!Array.isArray(field.options) || !field.options.length)
        throw new Error(`Setting "${field.key}" needs choices`)
      const options = new Set<string>()
      for (const option of field.options) {
        if (typeof option !== "string" && (!isPlainObject(option) || typeof option.value !== "string"))
          throw new Error(`Setting "${field.key}" choices must have string values`)
        const value = typeof option === "string" ? option : option.value
        if (typeof value !== "string")
          throw new Error(`Setting "${field.key}" choices must have string values`)
        if (options.has(value)) throw new Error(`Setting "${field.key}" choices must have unique values`)
        options.add(value)
        if (typeof option !== "string") {
          for (const key of ["label", "description"] as const) {
            if (option[key] !== undefined && typeof option[key] !== "string")
              throw new Error(`Setting "${field.key}" choice ${key} must be a string`)
          }
        }
      }
    } else if (field.type !== "toggle" && field.type !== "colour") {
      throw new Error(`Setting "${field.key}" has an unsupported type`)
    }
    const problem = validateExtensionSetting(field, field.default)
    if (problem) throw new Error(`Default for "${field.key}" ${problem}`)
  }
}

/**
 * The frozen settings snapshot with non-enumerable methods, so spreading, `Object.keys`,
 * JSON and `structuredClone` still see plain settings.
 */
export function settingsView(
  settings: Settings,
  layers: SettingsLayers,
  declare: SettingsView["declare"],
): SettingsView {
  const view = structuredClone(settings)
  const layerSnapshot = freeze(structuredClone(layers))
  const emptyLayers: readonly SettingsLayer[] = Object.freeze([])
  Object.defineProperty(view, "declare", { value: declare })
  Object.defineProperty(view, "layers", {
    value: <K extends keyof Settings>(key: K) =>
      (Object.hasOwn(layerSnapshot, key) ? layerSnapshot[key] : emptyLayers) as readonly SettingsLayer<
        NonNullable<Settings[K]>
      >[],
  })
  return freeze(view) as SettingsView
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
