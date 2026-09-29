import path from "node:path"
import { pathToFileURL } from "node:url"
import * as publicApi from "@amira/api"
import { API_VERSION, type Extension, type ExtensionAPI, type Settings } from "@amira/api"
import { runCommand } from "@amira/proc"
import { CommandRegistry, InputRegistry } from "./commands.ts"
import type { EventBus } from "./event-bus.ts"
import { amiraHome } from "./home.ts"
import type { InterceptorRegistry } from "./interceptors.ts"
import { PanelRegistry } from "./panel-registry.ts"
import { SkillRegistry } from "./skills.ts"
import { StatusRegistry } from "./status-registry.ts"
import type { ToolRegistry } from "./tool-registry.ts"
import { ToolRendererRegistry } from "./tool-renderers.ts"
import { UiRequests } from "./ui-requests.ts"
import { ViewRegistry } from "./view-registry.ts"

let virtualApiInstalled = false

/**
 * Lets extensions anywhere on disk `import "@amira/api"` without installing it,
 * including when Amira runs as a compiled executable.
 */
export function installVirtualApi(): void {
  if (virtualApiInstalled) return
  virtualApiInstalled = true
  Bun.plugin({
    name: "amira-virtual-api",
    setup(build) {
      build.module("@amira/api", () => ({ exports: { ...publicApi }, loader: "object" }))
    },
  })
}

export interface ExtensionHostOptions {
  bus: EventBus
  /** Merged settings handed to extensions. Default {}. */
  settings?: Settings
  interceptors: InterceptorRegistry
  tools: ToolRegistry
  status?: StatusRegistry
  /** Where live panels go. Default: a new registry. */
  panels?: PanelRegistry
  /** Where tool presenters go. Default: a new registry. */
  renderers?: ToolRendererRegistry
  /** Where full-screen view kinds go. Default: a new registry. */
  views?: ViewRegistry
  /** Where slash commands go. Default: a new registry. */
  commands?: CommandRegistry
  /** Where `$` skills go. Default: a new registry. */
  skills?: SkillRegistry
  /** Where input handlers go. Default: a new registry. */
  inputs?: InputRegistry
  /** Where extension dialogs go. Default: a new one on `bus`. */
  ui?: UiRequests
  /** Session id used on extension.* and ui.* events. Default "host". */
  sessionId?: string
  /** Working directory handed to extensions. Default: the process's. */
  cwd?: string
}

/**
 * Loads extensions and tracks everything each one registers, so a failed load is
 * rolled back completely and a loaded extension can be unloaded.
 */
export class ExtensionHost {
  #opts: ExtensionHostOptions
  #disposers = new Map<string, (() => void)[]>()
  #renderPending = false
  /** Extension files imported before, which a reload must import anew. */
  #imported = new Set<string>()
  readonly status: StatusRegistry
  readonly panels: PanelRegistry
  readonly renderers: ToolRendererRegistry
  readonly views: ViewRegistry
  readonly commands: CommandRegistry
  readonly skills: SkillRegistry
  readonly inputs: InputRegistry
  readonly ui: UiRequests

  constructor(opts: ExtensionHostOptions) {
    this.#opts = opts
    this.status = opts.status ?? new StatusRegistry()
    this.panels = opts.panels ?? new PanelRegistry()
    this.renderers = opts.renderers ?? new ToolRendererRegistry()
    this.views = opts.views ?? new ViewRegistry()
    this.commands = opts.commands ?? new CommandRegistry()
    this.skills = opts.skills ?? new SkillRegistry()
    this.inputs = opts.inputs ?? new InputRegistry()
    this.ui = opts.ui ?? new UiRequests(opts.bus, opts.sessionId ? { sessionId: opts.sessionId } : {})
  }

  get loaded(): string[] {
    return [...this.#disposers.keys()]
  }

  async load(ext: Extension, source: string): Promise<boolean> {
    if (this.#disposers.has(source)) return this.#fail(source, "already loaded")
    const disposers: (() => void)[] = []
    try {
      await ext(this.#apiFor(source, disposers))
    } catch (err) {
      for (const d of disposers.reverse()) d()
      this.#requestRender()
      return this.#fail(source, err instanceof Error ? err.message : String(err))
    }
    this.#disposers.set(source, disposers)
    this.#opts.bus.emit("extension.loaded", { source }, this.#meta())
    return true
  }

  async loadFile(file: string): Promise<boolean> {
    installVirtualApi()
    const abs = path.resolve(file)
    let mod: { default?: unknown }
    // The module cache would hand back the old code on a reload (Bun ignores a query on a file
    // URL, but drops an ES module from require.cache). Files the extension imports stay cached.
    if (this.#imported.has(abs)) delete require.cache[abs]
    this.#imported.add(abs)
    try {
      mod = await import(pathToFileURL(abs).href)
    } catch (err) {
      return this.#fail(abs, `failed to import: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (typeof mod.default !== "function") return this.#fail(abs, "extension must default-export a function")
    return this.load(mod.default as Extension, abs)
  }

  /** Removes every tool, listener and interceptor the extension registered. */
  unload(source: string): boolean {
    const disposers = this.#disposers.get(source)
    if (!disposers) return false
    for (const d of disposers.reverse()) d()
    this.#disposers.delete(source)
    this.#requestRender()
    return true
  }

  /** Unloads every extension, the last loaded first. */
  unloadAll(): void {
    for (const source of this.loaded.reverse()) this.unload(source)
  }

  /** Coalesces render requests into one ui.render per macrotask. */
  #requestRender() {
    if (this.#renderPending) return
    this.#renderPending = true
    setTimeout(() => {
      this.#renderPending = false
      this.#opts.bus.emit("ui.render", {}, this.#meta())
    }, 0)
  }

  #fail(source: string, error: string): false {
    this.#opts.bus.emit("extension.error", { source, error }, this.#meta())
    return false
  }

  #meta() {
    return { sessionId: this.#opts.sessionId ?? "host" }
  }

  /** Dialogs an extension leaves open are cancelled when it unloads. */
  #uiFor(source: string, track: (d: () => void) => void) {
    track(() => this.ui.cancelAll(source))
    return this.ui.api(source)
  }

  #apiFor(source: string, disposers: (() => void)[]): ExtensionAPI {
    const { bus, interceptors, tools } = this.#opts
    const track = (d: () => void) => {
      disposers.push(d)
      return d
    }
    return {
      apiVersion: API_VERSION,
      cwd: this.#opts.cwd ?? process.cwd(),
      home: amiraHome(),
      reportError: (error) => void this.#fail(source, error),
      registerTool: (tool) => track(tools.register(tool, source)),
      // A taken name skips only this command, not the whole extension.
      registerCommand: (command) => {
        try {
          return track(this.commands.register(command, source, (w) => void this.#fail(source, w)))
        } catch (err) {
          this.#fail(source, err instanceof Error ? err.message : String(err))
          return () => {}
        }
      },
      // Likewise a taken skill name skips only that skill.
      registerSkill: (skill) => {
        try {
          return track(this.skills.register(skill, source))
        } catch (err) {
          this.#fail(source, err instanceof Error ? err.message : String(err))
          return () => {}
        }
      },
      registerInputHandler: (handler) => {
        try {
          return track(this.inputs.register(handler, source))
        } catch (err) {
          this.#fail(source, err instanceof Error ? err.message : String(err))
          return () => {}
        }
      },
      on: (type, handler) =>
        track(
          bus.subscribe(
            (e) => {
              if (e.type === type) return handler(e as never)
            },
            { types: [type] },
          ),
        ),
      intercept: (point, handler, options) => track(interceptors.add(point, handler, options, source)),
      // Each extension gets its own frozen copy, so none can change what another reads.
      settings: deepFreeze(structuredClone(this.#opts.settings ?? {})),
      registerStatusItem: (item) => {
        const off = this.status.register(item)
        this.#requestRender()
        return track(() => {
          off()
          this.#requestRender()
        })
      },
      // A taken id skips only this panel.
      registerPanel: (panel) => {
        let off: () => void
        try {
          off = this.panels.register(panel)
        } catch (err) {
          this.#fail(source, err instanceof Error ? err.message : String(err))
          return () => {}
        }
        this.#requestRender()
        return track(() => {
          off()
          this.#requestRender()
        })
      },
      registerToolRenderer: (toolName, presenter) => track(this.renderers.register(toolName, presenter)),
      // A kind that cannot be taken skips only that view.
      registerView: (view) => {
        try {
          return track(this.views.register(view))
        } catch (err) {
          this.#fail(source, err instanceof Error ? err.message : String(err))
          return () => {}
        }
      },
      requestRender: () => this.#requestRender(),
      runCommand: (argv, options) => runCommand(argv, options),
      ui: this.#uiFor(source, track),
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}
