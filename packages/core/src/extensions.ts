import path from "node:path"
import { pathToFileURL } from "node:url"
import * as publicApi from "@amira/api"
import { API_VERSION, type Extension, type ExtensionAPI, type Settings } from "@amira/api"
import { runCommand } from "@amira/proc"
import type { EventBus } from "./event-bus.ts"
import { amiraHome } from "./home.ts"
import type { InterceptorRegistry } from "./interceptors.ts"
import { StatusRegistry } from "./status-registry.ts"
import type { ToolRegistry } from "./tool-registry.ts"
import { UiRequests } from "./ui-requests.ts"

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
  readonly status: StatusRegistry
  readonly ui: UiRequests

  constructor(opts: ExtensionHostOptions) {
    this.#opts = opts
    this.status = opts.status ?? new StatusRegistry()
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
      settings: this.#opts.settings ?? {},
      registerStatusItem: (item) => {
        const off = this.status.register(item)
        this.#requestRender()
        return track(() => {
          off()
          this.#requestRender()
        })
      },
      requestRender: () => this.#requestRender(),
      runCommand: (argv, options) => runCommand(argv, options),
      ui: this.#uiFor(source, track),
    }
  }
}
