// Owns runtime theme selection, registry reloads and the interactive preview picker.
import type { CommandContext, CommandDefinition, ThemeDefinition } from "@amira/api"
import {
  backgroundFromEnv,
  backgroundOf,
  type Capabilities,
  createTheme,
  defaultGlyphs,
  isColorEnabled,
  type Glyphs as MarkdownGlyphs,
  type Theme,
} from "@amira/tui-kit"
import { Dialog } from "../dialog.ts"
import { type Glyphs, glyphs, setGlyphs } from "../glyphs.ts"
import type { Keybindings } from "../keybindings.ts"
import type { OverlayManager } from "./overlays.ts"
import type { InteractiveOptions } from "./startup.ts"

const LEGACY = [
  { name: "auto", description: "Default palette for the terminal background" },
  { name: "dark", description: "Default dark palette" },
  { name: "light", description: "Default light palette" },
  { name: "terminal", description: "Use the terminal's ANSI colors" },
]

interface Selection {
  name: string
  theme: Theme
  markdownGlyphs: MarkdownGlyphs
  glyphs: Partial<Glyphs>
  variant: "dark" | "light"
}

export class RuntimeThemes {
  private selection: Selection
  private readonly originalGlyphs = { ...glyphs }
  private changed: ((selection: Selection) => void) | undefined
  private off: (() => void) | undefined
  private registryVersion = 0

  constructor(
    private readonly opts: InteractiveOptions,
    private readonly env: Record<string, string | undefined>,
    private readonly capabilities: Capabilities,
  ) {
    this.selection = this.build(opts.settings?.theme ?? "auto")
    if (opts.theme) this.selection.theme = opts.theme
    setGlyphs(this.selection.glyphs)
  }

  get current(): Selection {
    return this.selection
  }

  /** Connect after the editor, renderers and overlays exist; reloads preserve the selected name. */
  connect(changed: (selection: Selection) => void): void {
    this.changed = changed
    this.off = this.opts.themes?.subscribe(() => {
      this.registryVersion++
      this.select(this.selection.name)
    })
  }

  private build(name: string): Selection {
    const definition = this.opts.themes?.get(
      name === "auto" || name === "dark" || name === "light" ? "amira" : name,
    )
    const setting = this.opts.settings
    const variant =
      name === "dark" || name === "light"
        ? name
        : setting?.themeVariant === "dark" || setting?.themeVariant === "light"
          ? setting.themeVariant
          : (this.capabilities.background ??
            (this.capabilities.backgroundRgb
              ? backgroundOf(this.capabilities.backgroundRgb)
              : backgroundFromEnv(this.env)) ??
            "dark")
    return {
      name,
      variant,
      theme: createTheme({
        theme: name,
        definition,
        themeVariant: setting?.themeVariant,
        colorDepth: setting?.colorDepth,
        env: this.env,
        capabilities: this.capabilities,
        color: isColorEnabled(),
      }),
      markdownGlyphs: { ...defaultGlyphs, ...this.markdownGlyphs(definition) },
      glyphs: definition?.glyphs ?? {},
    }
  }

  private markdownGlyphs(definition: ThemeDefinition | undefined): Partial<MarkdownGlyphs> {
    const overrides: Partial<MarkdownGlyphs> = {}
    // Copy only kit keys: the same definition also contains the TUI's formatting symbols.
    for (const key of Object.keys(defaultGlyphs) as (keyof MarkdownGlyphs)[]) {
      const value = definition?.glyphs?.[key]
      if (value !== undefined) Object.assign(overrides, { [key]: value })
    }
    return overrides
  }

  private restore(selection: Selection): void {
    this.selection = selection
    setGlyphs(selection.glyphs)
    this.changed?.(selection)
  }

  private select(name: string): void {
    this.restore(this.build(name))
  }

  private entries(): { name: string; description?: string }[] {
    const entries = new Map(
      LEGACY.map((entry) => [entry.name, { ...entry, description: `built-in · ${entry.description}` }]),
    )
    for (const entry of this.opts.themes?.list() ?? []) {
      const source = this.opts.themes?.source?.(entry.name) ?? "built-in"
      entries.set(entry.name, {
        name: entry.name,
        description: `${source}${entry.description ? ` · ${entry.description}` : ""}`,
      })
    }
    return [...entries.values()]
  }

  command(deps: {
    overlays: OverlayManager
    keys: Keybindings
    requestRender: () => void
  }): CommandDefinition {
    return {
      name: "theme",
      description: "Choose a terminal theme with live preview",
      args: {
        hint: "[name]",
        complete: () =>
          this.entries().map((entry) => ({ value: entry.name, description: entry.description })),
      },
      run: async (args, ctx) => {
        if (ctx.frontend !== "tui")
          return ctx.print("/theme only changes the interactive terminal UI.", "warning")
        const name = args.trim()
        if (name) {
          if (!this.entries().some((entry) => entry.name === name))
            return ctx.print(`Unknown theme "${name}". Use /theme to choose one.`, "error")
          this.select(name)
          await this.opts.saveTheme?.(name)
          ctx.print(`Theme: ${name}`)
          return
        }
        if (deps.overlays.hasFullscreen || deps.overlays.dialogs.length)
          return ctx.print("Close the current dialog or view before choosing a theme.", "warning")
        await this.pick(ctx, deps)
      },
    }
  }

  private pick(
    ctx: CommandContext,
    deps: { overlays: OverlayManager; keys: Keybindings; requestRender: () => void },
  ): Promise<void> {
    const previous = this.selection
    const registryVersion = this.registryVersion
    const entries = this.entries()
    return new Promise<void>((resolve, reject) => {
      let finished = false
      let close: (() => void) | undefined
      const finish = (name: string | undefined) => {
        if (finished) return
        finished = true
        ctx.signal.removeEventListener("abort", cancel)
        close?.()
        if (name !== undefined && !this.entries().some((entry) => entry.name === name)) {
          ctx.print(`Theme "${name}" is no longer available.`, "warning")
          name = undefined
        }
        if (name === undefined) {
          if (registryVersion === this.registryVersion) this.restore(previous)
          else this.select(previous.name)
          resolve()
        } else {
          const applied = name
          this.select(applied)
          Promise.resolve()
            .then(() => this.opts.saveTheme?.(applied))
            .then(() => {
              ctx.print(`Theme: ${applied}`)
              resolve()
            }, reject)
        }
        deps.requestRender()
      }
      const cancel = () => finish(undefined)
      const dialog = new Dialog(
        {
          kind: "select",
          requestId: "tui-theme",
          title: "Choose a theme (arrows preview, Enter applies, Esc restores)",
          initial: previous.name,
          options: entries.map((entry) => entry.name),
          descriptions: entries.map((entry) => entry.description ?? ""),
        },
        (answer) =>
          finish(
            typeof answer === "string"
              ? answer
              : typeof answer === "object" && answer && "option" in answer
                ? answer.option
                : undefined,
          ),
        deps.keys,
        { changed: (name) => this.select(name) },
      )
      if (ctx.signal.aborted) return cancel()
      ctx.signal.addEventListener("abort", cancel, { once: true })
      close = deps.overlays.openLocalDialog(dialog)
    })
  }

  dispose(): void {
    this.off?.()
    this.changed = undefined
    setGlyphs(this.originalGlyphs)
  }
}
