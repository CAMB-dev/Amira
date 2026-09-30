import path from "node:path"
import { pathToFileURL } from "node:url"
import * as publicApi from "@amira/api"
import {
  type AnyEvent,
  API_VERSION,
  type Extension,
  type ExtensionAPI,
  type NoticeLevel,
  type RunCommandOptions,
  type RunCommandResult,
  type Settings,
} from "@amira/api"
import { runCommand } from "@amira/proc"
import { CommandRegistry, InputRegistry } from "./commands.ts"
import type { EventBus } from "./event-bus.ts"
import { amiraHome } from "./home.ts"
import type { InterceptorRegistry } from "./interceptors.ts"
import { PanelRegistry } from "./panel-registry.ts"
import { openExtensionPipe } from "./pipes.ts"
import { ImageProviderRegistry, MarkdownRendererRegistry, ServiceRegistry } from "./render-registry.ts"
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
  #exitHandlers = new Set<{ source: string; run: (signal: AbortSignal) => void | Promise<void> }>()
  #renderPending = false
  /** Extension files imported before, which a reload must import anew. */
  #imported = new Set<string>()
  /** What to add to an extension's failures, by source: e.g. how to turn its package off. */
  #hints = new Map<string, string>()
  /** Events the extensions being loaded get first (replayOnLoad). */
  #replay: AnyEvent[] | undefined
  /** Failures of each extension's event handlers, by source and event type. */
  #handlerFailures = new Map<string, number>()
  readonly status: StatusRegistry
  readonly panels: PanelRegistry
  readonly renderers: ToolRendererRegistry
  readonly views: ViewRegistry
  readonly commands: CommandRegistry
  readonly skills: SkillRegistry
  readonly inputs: InputRegistry
  readonly ui: UiRequests
  /** Renderers of Markdown nodes (D88). */
  readonly markdown: MarkdownRendererRegistry
  /** Where images get drawable (D88). */
  readonly images: ImageProviderRegistry
  /** What extensions offer each other (D88). */
  readonly services: ServiceRegistry

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
    this.markdown = new MarkdownRendererRegistry((source, error) => void this.#fail(source, error))
    this.images = new ImageProviderRegistry()
    this.services = new ServiceRegistry()
  }

  get loaded(): string[] {
    return [...this.#disposers.keys()]
  }

  /** The settings handed to extensions loaded from now on (e.g. on a reload, with new skill directories). */
  setSettings(settings: Settings): void {
    this.#opts = { ...this.#opts, settings }
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

  /**
   * Imports an extension file and loads it. `source` names it in errors, /help and the like
   * (default: the file's path); `hint` is added to its failures, e.g. how to turn it off.
   */
  async loadFile(file: string, label: { source?: string; hint?: string } = {}): Promise<boolean> {
    installVirtualApi()
    const abs = path.resolve(file)
    const source = label.source ?? abs
    if (label.hint) this.#hints.set(source, label.hint)
    let mod: { default?: unknown }
    // The module cache would hand back the old code on a reload (Bun ignores a query on a file
    // URL, but drops an ES module from require.cache). Files the extension imports stay cached.
    if (this.#imported.has(abs)) delete require.cache[abs]
    this.#imported.add(abs)
    try {
      mod = await import(pathToFileURL(abs).href)
    } catch (err) {
      return this.#fail(source, `failed to import: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (typeof mod.default !== "function")
      return this.#fail(source, "extension must default-export a function")
    return this.load(mod.default as Extension, source)
  }

  /**
   * Events the extensions loaded from now on get first, in their listeners registered while
   * loading: on a reload, what tells them where the session is (the status its model, context,
   * cost and branch). Undefined stops it.
   */
  replayOnLoad(events: AnyEvent[] | undefined): void {
    this.#replay = events
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

  /** Unloads every extension, the last loaded first. Their handlers' failures start counting afresh. */
  unloadAll(): void {
    for (const source of this.loaded.reverse()) this.unload(source)
    this.#handlerFailures.clear()
    this.#hints.clear()
  }

  /**
   * Runs the extensions' exit handlers (ExtensionAPI.onExit) together and resolves once all
   * finished. After `timeoutMs` their signal aborts, and they get `graceMs` more to stop (e.g.
   * for a command they started to be killed) before this resolves anyway. Failures are reported
   * as extension.error. Never rejects.
   */
  async runExitHandlers(timeoutMs = 4000, graceMs = 1000): Promise<void> {
    const handlers = [...this.#exitHandlers]
    if (!handlers.length) return
    // Only once the extensions got what was emitted before (session.end): the bus delivers
    // asynchronously. A subscriber that is stuck holds this up for a moment at most.
    await Promise.race([this.#opts.bus.flush(), Bun.sleep(500)])
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        abort.abort()
        timer = setTimeout(resolve, graceMs)
      }, timeoutMs)
    })
    const runs = handlers.map(async (h) => {
      try {
        await h.run(abort.signal)
      } catch (err) {
        this.#fail(h.source, `exit handler failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    })
    try {
      await Promise.race([Promise.all(runs), late])
    } finally {
      clearTimeout(timer)
    }
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
    const hint = this.#hints.get(source)
    this.#opts.bus.emit(
      "extension.error",
      { source, error: hint ? `${error} (${hint})` : error },
      this.#meta(),
    )
    return false
  }

  /**
   * An extension's event handler threw: reported the first time for that extension and event,
   * then counted, and reported again at 10, 100, 1000 failures, so a handler failing on every
   * event does not flood the transcript.
   */
  #handlerFailed(source: string, type: string, err: unknown) {
    const key = `${source}\0${type}`
    const n = (this.#handlerFailures.get(key) ?? 0) + 1
    this.#handlerFailures.set(key, n)
    const message = err instanceof Error ? err.message : String(err)
    if (n === 1) this.#fail(source, `its ${type} handler failed: ${message}`)
    else if (n === 10 || n === 100 || n === 1000)
      this.#fail(source, `its ${type} handler has failed ${n} times now; the latest: ${message}`)
  }

  #meta() {
    return { sessionId: this.#opts.sessionId ?? "host" }
  }

  /** Runs a registration; one that throws is reported and skipped. A render is asked for. */
  #register(source: string, track: (d: () => void) => () => void, add: () => () => void): () => void {
    let off: () => void
    try {
      off = add()
    } catch (err) {
      this.#fail(source, err instanceof Error ? err.message : String(err))
      return () => {}
    }
    this.#requestRender()
    return track(() => {
      off()
      this.#requestRender()
    })
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
      notify: (text, level = "info") =>
        void bus.emit(
          "extension.notice",
          { source, text: String(text), level: NOTICE_LEVELS.includes(level) ? level : "info" },
          this.#meta(),
        ),
      onExit: (run) => {
        const entry = { source, run }
        this.#exitHandlers.add(entry)
        return track(() => void this.#exitHandlers.delete(entry))
      },
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
      // A handler that throws is reported as the extension's failure, not the host's.
      on: (type, handler) =>
        track(
          bus.subscribe(
            async (e) => {
              if (e.type !== type) return
              try {
                await handler(e as never)
              } catch (err) {
                this.#handlerFailed(source, type, err)
              }
            },
            { types: [type], ...(this.#replay ? { replay: this.#replay } : {}) },
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
      decorateToolRenderer: (toolName, decorate) => track(this.renderers.decorate(toolName, decorate)),
      // A kind that cannot be taken skips only that view.
      registerView: (view) => {
        try {
          return track(this.views.register(view))
        } catch (err) {
          this.#fail(source, err instanceof Error ? err.message : String(err))
          return () => {}
        }
      },
      // A renderer, provider or service that cannot be taken skips only that one.
      registerMarkdownRenderer: (renderer) =>
        this.#register(source, track, () => this.markdown.register(renderer, source)),
      registerImageProvider: (provider) =>
        this.#register(source, track, () => this.images.register(provider, source)),
      provideService: (name, service) =>
        this.#register(source, track, () => this.services.provide(name, service, source)),
      useService: (name) => this.services.get(name) as never,
      requestRender: () => this.#requestRender(),
      runCommand: (argv, options) => runExtensionCommand(argv, options),
      openPipe: (argv, options) => openExtensionPipe(argv, options),
      ui: this.#uiFor(source, track),
    }
  }
}

/**
 * ExtensionAPI.runCommand: `stdin` travels as the gate line, which is written once the process
 * tree is contained and then closes stdin.
 */
export function runExtensionCommand(argv: string[], options: RunCommandOptions): Promise<RunCommandResult> {
  const { stdin, ...rest } = options
  if (stdin === undefined) return runCommand(argv, rest)
  if (rest.gated || rest.viaCmd) {
    return Promise.reject(new Error("runCommand: stdin cannot be combined with gated or viaCmd"))
  }
  return runCommand(argv, {
    ...rest,
    gated: true,
    gateLine: stdin.endsWith("\n") ? stdin.slice(0, -1) : stdin,
  })
}

const NOTICE_LEVELS: readonly NoticeLevel[] = ["info", "success", "warning", "error"]

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}
