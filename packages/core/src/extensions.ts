import path from "node:path"
import { pathToFileURL } from "node:url"
import * as publicApi from "@amira/api"
import { API_VERSION, type Extension, type ExtensionAPI } from "@amira/api"
import type { EventBus } from "./event-bus.ts"
import type { InterceptorRegistry } from "./interceptors.ts"
import type { ToolRegistry } from "./tool-registry.ts"

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
  interceptors: InterceptorRegistry
  tools: ToolRegistry
  /** Reports load failures; the failing extension is skipped and others keep loading. */
  onError?: (source: string, error: string) => void
}

export class ExtensionHost {
  #opts: ExtensionHostOptions
  #loaded: string[] = []

  constructor(opts: ExtensionHostOptions) {
    this.#opts = opts
  }

  get loaded(): readonly string[] {
    return this.#loaded
  }

  async load(ext: Extension, source: string): Promise<boolean> {
    const api = this.#apiFor(source)
    try {
      await ext(api)
      this.#loaded.push(source)
      return true
    } catch (err) {
      this.#opts.onError?.(source, err instanceof Error ? err.message : String(err))
      return false
    }
  }

  async loadFile(file: string): Promise<boolean> {
    installVirtualApi()
    const abs = path.resolve(file)
    let mod: { default?: unknown }
    try {
      mod = await import(pathToFileURL(abs).href)
    } catch (err) {
      this.#opts.onError?.(abs, `failed to import: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
    if (typeof mod.default !== "function") {
      this.#opts.onError?.(abs, "extension must default-export a function")
      return false
    }
    return this.load(mod.default as Extension, abs)
  }

  #apiFor(source: string): ExtensionAPI {
    const { bus, interceptors, tools } = this.#opts
    return {
      apiVersion: API_VERSION,
      registerTool: (tool) => void tools.register(tool, source),
      on: (type, handler) => bus.subscribe((e) => handler(e as never), { types: [type] }),
      intercept: (point, handler, options) => interceptors.add(point, handler, options, source),
    }
  }
}
