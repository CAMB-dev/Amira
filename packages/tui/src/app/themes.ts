// Owns runtime theme selection, registry reloads and the interactive preview picker.
import type { CommandContext, CommandDefinition, ShimmerEffect, ThemeDefinition } from "@amira/api"
import { resolveShimmer, SHIMMER_PRESETS } from "@amira/core"
import {
  backgroundFromEnv,
  backgroundOf,
  type Capabilities,
  chromeGlyphs,
  createTheme,
  defaultGlyphs,
  isColorEnabled,
  type Glyphs as MarkdownGlyphs,
  type Theme,
  type ThemeVariant,
} from "@amira/tui-kit"
import { reloadClockSetting } from "../clock.ts"
import { type Glyphs, glyphs, setGlyphs } from "../glyphs.ts"
import { type Keybindings, keyLabel } from "../keybindings.ts"
import type { OverlayManager } from "./overlays.ts"
import { configureShimmer } from "./shimmer.ts"
import { ShimmerControl, shimmerColorChoices, ThemePickerDialog } from "./shimmer-control.ts"
import type { InteractiveOptions } from "./startup.ts"

const BUILTINS = ["amira", "amber", "burnt", "lavender", "mono", "ascii"]
const VARIANTS: ThemeVariant[] = ["auto", "dark", "light"]
const LEGACY = new Set(["auto", "dark", "light"])

interface Selection {
  name: string
  theme: Theme
  markdownGlyphs: MarkdownGlyphs
  glyphs: Partial<Glyphs>
  variant: "dark" | "light"
  themeVariant: ThemeVariant
}

export class RuntimeThemes {
  private selection: Selection
  private readonly originalGlyphs = { ...glyphs }
  private changed: ((selection: Selection) => void) | undefined
  private off: (() => void) | undefined
  private offSettings: (() => void) | undefined
  private cancelPicker: (() => void) | undefined
  private registryVersion = 0
  private shimmer: ShimmerEffect | undefined
  private isPreviewing = false

  constructor(
    private readonly opts: InteractiveOptions,
    private readonly env: Record<string, string | undefined>,
    private readonly capabilities: Capabilities,
  ) {
    this.shimmer = opts.settings?.shimmer
    this.selection = this.build(opts.settings?.theme ?? "auto", opts.settings?.themeVariant ?? "auto")
    if (opts.theme) {
      this.selection.theme = opts.theme
      configureShimmer(
        opts.theme,
        resolveShimmer(opts.themes?.get(this.selection.name)?.shimmerEffect, this.shimmer),
      )
    }
    setGlyphs(this.selection.glyphs)
  }

  get current(): Selection {
    return this.selection
  }

  get previewing(): boolean {
    return this.isPreviewing
  }

  /** Connect after the editor, renderers and overlays exist; reloads preserve the selected name. */
  connect(changed: (selection: Selection) => void): void {
    this.changed = changed
    this.off = this.opts.themes?.subscribe(() => {
      this.registryVersion++
      this.select(this.selection.name, this.selection.themeVariant)
    })
    this.offSettings = this.opts.subscribeThemeSettings?.((settings) => {
      // The clock is presentation too: a reloaded tui.clock applies at once.
      reloadClockSetting(settings?.clock)
      this.cancelPicker?.()
      this.shimmer = settings?.shimmer
      this.select(settings?.theme ?? "auto", settings?.themeVariant ?? "auto")
    })
  }

  private build(name: string, themeVariant: ThemeVariant): Selection {
    if (LEGACY.has(name)) {
      if (name === "dark" || name === "light") themeVariant = name
      name = "amira"
    }
    const definition = this.opts.themes?.get(name)
    const setting = this.opts.settings
    const variant =
      themeVariant === "dark" || themeVariant === "light"
        ? themeVariant
        : (this.capabilities.background ??
          (this.capabilities.backgroundRgb
            ? backgroundOf(this.capabilities.backgroundRgb)
            : backgroundFromEnv(this.env)) ??
          "dark")
    const shimmer = resolveShimmer(definition?.shimmerEffect, this.shimmer)
    const theme = createTheme({
      theme: name,
      definition,
      themeVariant,
      shimmerColors: shimmer.colors && ("dark" in shimmer.colors ? shimmer.colors[variant] : shimmer.colors),
      colorDepth: setting?.colorDepth,
      env: this.env,
      capabilities: this.capabilities,
      color: isColorEnabled(),
    })
    configureShimmer(theme, shimmer)
    return {
      name,
      variant,
      themeVariant,
      theme,
      markdownGlyphs: {
        ...defaultGlyphs,
        ...chromeGlyphs(definition?.glyphs),
        ...this.markdownGlyphs(definition),
      },
      glyphs: definition?.glyphs ?? {},
    }
  }

  private markdownGlyphs(definition: ThemeDefinition | undefined): Partial<MarkdownGlyphs> {
    const overrides: Partial<MarkdownGlyphs> = {}
    // Copy only kit keys: the same definition also contains the TUI's formatting symbols.
    for (const [key, value] of Object.entries(definition?.glyphs ?? {})) {
      if (key in defaultGlyphs) Object.assign(overrides, { [key]: value })
    }
    return overrides
  }

  private restore(selection: Selection): void {
    this.selection = selection
    setGlyphs(selection.glyphs)
    this.changed?.(selection)
  }

  private select(name: string, themeVariant = this.selection.themeVariant): void {
    this.restore(this.build(name, themeVariant))
  }

  private entries(): { name: string; description?: string }[] {
    const entries = new Map<string, { name: string; description?: string }>(
      BUILTINS.map((name) => [name, { name, description: "built-in" }]),
    )
    for (const entry of this.opts.themes?.list() ?? []) {
      const source = this.opts.themes?.source?.(entry.name) ?? "built-in"
      entries.set(entry.name, {
        name: entry.name,
        description: `${source}${entry.description ? ` · ${entry.description}` : ""}`,
      })
    }
    entries.set("terminal", { name: "terminal", description: "built-in · Use the terminal's ANSI colors" })
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
          if (!LEGACY.has(name) && !this.entries().some((entry) => entry.name === name))
            return ctx.print(`Unknown theme "${name}". Use /theme to choose one.`, "error")
          this.select(name, name === "auto" ? "auto" : this.selection.themeVariant)
          await this.opts.saveTheme?.(this.selection.name, this.selection.themeVariant)
          ctx.print(`Theme: ${this.selection.name} (${this.selection.themeVariant})`)
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
    const previousShimmer = this.shimmer
    const registryVersion = this.registryVersion
    const entries = this.entries()
    let themeVariant = previous.themeVariant
    const shimmer = new ShimmerControl(this.shimmer, {
      keys: deps.keys,
      definition: () => this.opts.themes?.get(this.selection.name),
      variant: () => this.selection.variant,
      colors: () => shimmerColorChoices(BUILTINS.map((name) => this.opts.themes?.get(name) ?? { name })),
      changed: (override) => {
        this.shimmer = override
        this.select(this.selection.name, themeVariant)
      },
    })
    return new Promise<void>((resolve, reject) => {
      let finished = false
      let close: (() => void) | undefined
      const finish = (name: string | undefined) => {
        if (finished) return
        finished = true
        this.cancelPicker = undefined
        ctx.signal.removeEventListener("abort", cancel)
        close?.()
        if (name !== undefined && !this.entries().some((entry) => entry.name === name)) {
          ctx.print(`Theme "${name}" is no longer available.`, "warning")
          name = undefined
        }
        this.isPreviewing = false
        deps.overlays.echoLocalDialog(dialog, name)
        if (name === undefined) {
          this.shimmer = previousShimmer
          if (registryVersion === this.registryVersion) this.restore(previous)
          else this.select(previous.name, previous.themeVariant)
          resolve()
        } else {
          const applied = name
          const inherited = resolveShimmer(this.opts.themes?.get(applied)?.shimmerEffect)
          if (
            this.shimmer === "soft" &&
            Object.entries(SHIMMER_PRESETS.soft).every(
              ([key, value]) => inherited[key as keyof typeof inherited] === value,
            )
          )
            this.shimmer = undefined
          const appliedShimmer = this.shimmer
          this.select(applied, themeVariant)
          Promise.resolve()
            .then(() => this.opts.saveTheme?.(applied, themeVariant, appliedShimmer))
            .then(() => {
              ctx.print(`Theme: ${applied} (${themeVariant})`)
              resolve()
            }, reject)
        }
        deps.requestRender()
      }
      const cancel = () => finish(undefined)
      const dialog = new ThemePickerDialog(
        {
          kind: "select",
          requestId: "tui-theme",
          title: "Choose a theme",
          initial: previous.name,
          options: entries.map((entry) => entry.name),
          descriptions: entries.map(
            (entry) => `${entry.description ?? ""}${entry.name === previous.name ? " · current" : ""}`,
          ),
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
        {
          changed: (name) => this.select(name, themeVariant),
          footer: [
            {
              text: `${keyLabel({ name: "tab" }).toLowerCase()} appearance/shimmer`,
              priority: 6,
            },
            {
              // The arrows change a control only while one has focus, not the list.
              get text() {
                return shimmer.focus === "list"
                  ? ""
                  : `${keyLabel({ name: "left" })}/${keyLabel({ name: "right" })} change`
              },
              priority: 5,
            },
          ],
          // Arrows preview; Enter applies (or opens the shimmer knobs), Esc restores.
          choose: () => (shimmer.opensCustomize ? "customize" : "apply"),
          cancel: "restore",
          listFocused: () => shimmer.focus === "list",
          header: (theme) => shimmer.header(themeVariant, theme),
          handleInput: (event) => {
            if (shimmer.handleInput(event)) return true
            if (event.type !== "key" || event.ctrl || event.alt) return false
            if (shimmer.focus !== "appearance" || !["left", "right"].includes(event.name)) return false
            const step = event.name === "left" ? -1 : 1
            themeVariant =
              VARIANTS[(VARIANTS.indexOf(themeVariant) + step + VARIANTS.length) % VARIANTS.length]!
            this.select(this.selection.name, themeVariant)
            return true
          },
        },
      )
      dialog.shimmer = shimmer
      if (ctx.signal.aborted) return cancel()
      ctx.signal.addEventListener("abort", cancel, { once: true })
      this.cancelPicker = cancel
      this.isPreviewing = true
      this.select(previous.name, themeVariant)
      close = deps.overlays.openLocalDialog(dialog)
    })
  }

  dispose(): void {
    this.off?.()
    this.offSettings?.()
    this.cancelPicker = undefined
    this.changed = undefined
    setGlyphs(this.originalGlyphs)
  }
}
