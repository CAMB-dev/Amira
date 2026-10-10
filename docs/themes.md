# Themes

[简体中文](zh/themes.md) · [Documentation](../README.md)

Themes change semantic colors and symbols without changing the terminal's own background or foreground. Built-ins are `amira` (the default cyan palette), `amber`, `burnt`, `lavender`, `mono` (neutral accents with colored status indicators), and `ascii` (default colors with ASCII glyphs). Built-in definitions live in [`packages/cli/themes`](../packages/cli/themes).

## Choose a theme

Use `/theme` to open the theme picker with each theme's name, source and description. The list starts with `amira`, `amber`, `burnt`, `lavender`, `mono` and `ascii`, followed by custom themes, with `terminal` last. The current theme is marked. Up/down arrows preview themes immediately; Tab or left/right arrows cycle the separate appearance control between `auto`, `dark` and `light` (Shift+Tab cycles backward). Enter applies the theme and appearance together. Esc restores both without saving, including when theme definitions reload during a preview.

`/theme <name>` selects a theme directly while keeping the chosen appearance. The legacy commands `/theme auto`, `/theme dark` and `/theme light` select Amira with that appearance. Legacy settings still work and appear as the current Amira theme in the picker. Interactive choices save both `tui.theme` and `tui.themeVariant` like model choices: in the user settings and, when allowed, the project's `settings.local.json`. See [Settings reference](settings.md#saving-model-and-thinking-choices) for project-save restrictions.

You can also set a name in `settings.json`:

```json
{
  "tui": {
    "theme": "ascii",
    "themeVariant": "auto"
  }
}
```

`tui.themeVariant` accepts `auto`, `dark` and `light`. `auto` follows the detected terminal background, defaulting to dark when it is unknown. `dark` or `light` forces that appearance. Colors omitted from the chosen variant inherit Amira's defaults for that appearance. If a theme supplies only `dark`, choosing `light` uses the default light palette, not the theme's dark colors; glyph overrides still apply. The same rule holds in reverse for a light-only theme.

Runtime changes redraw the full-screen transcript and active inline regions immediately. Output already committed to inline scrollback keeps its original styling.

The existing `tui.theme` choices remain valid: `auto` follows the terminal with Amira's palette, `dark` and `light` explicitly choose Amira's palette, and `terminal` uses the terminal's ANSI colors. Named themes do not force truecolor: the color-depth setting and monochrome behavior still apply.

## Files and precedence

Each JSON file contains one theme, identified by `name`, not by its filename. Layers load in the following order; a later definition with the same name replaces the whole earlier definition and produces a notice:

1. Built-in themes, bundled with the CLI.
2. `~/.amira/themes/*.json`, or `$AMIRA_HOME/themes/*.json` when `AMIRA_HOME` is set.
3. `<cwd>/.amira/themes/*.json` in the starting working directory, not the Git root.
4. JSON paths in active packages' manifest `themes` lists. Disabled packages and untrusted project packages are excluded.
5. Themes registered by extensions with `api.registerTheme`.

Directory filenames are sorted lexically, without depending on locale. Package paths follow active package order and each manifest's declared order. Only immediate `.json` files in the theme directories load; subdirectories are not scanned. Missing directories are fine. An unreadable file, invalid JSON or an invalid definition produces a notice instead of stopping startup; other files still load. Unknown fields and tokens are reported and ignored. Invalid glyph overrides are ignored individually, retaining their defaults.

Restart Amira or run `/reload` while idle after changing theme files or package contributions. Reload replaces the file snapshot, so removed files no longer register themes. Extension registrations remain above the file layers; unloading an extension restores the definition beneath it.

## Theme format

The format is [`ThemeDefinition`](../packages/api/src/themes.ts). `name` is required and must be non-empty, with no surrounding whitespace or control characters. `description`, `dark`, `light` and `glyphs` are optional. Colors are opaque `#RGB` or `#RRGGBB` hex strings; names such as `cyan`, CSS functions, alpha channels and ANSI escape sequences are not accepted.

A palette is a set of partial overrides, not a replacement for every default color. `bg` and `fg` are reference colors for surfaces, not requests to repaint the terminal. `shimmer` and `shimmerEnd` are independent gradient stops; when omitted, they inherit the default Amira gradient for that appearance. The following complete file shows all palette keys and a few glyph overrides. Save it as `~/.amira/themes/my-theme.json`:

```json
{
  "name": "my-theme",
  "description": "Default colors with simple list and code-frame symbols",
  "dark": {
    "bg": "#121212",
    "fg": "#e4e4e4",
    "accent": "#78dbe2",
    "heading1": "#6fb3e8",
    "heading": "#78dbe2",
    "path": "#9ab8f0",
    "command": "#a8e6ea",
    "fg2": "#bdbdbd",
    "muted": "#727272",
    "dim": "#4a4a4a",
    "border": "#333333",
    "borderFocused": "#565656",
    "success": "#8fc46a",
    "error": "#e5737a",
    "warning": "#e2b356",
    "thinking": "#a8927a",
    "userBg": "#202020",
    "codeBg": "#191919",
    "diffAddedBg": "#0f3a12",
    "diffRemovedBg": "#47141a",
    "diffAddedWordBg": "#17551c",
    "diffRemovedWordBg": "#66212a",
    "keyword": "#6fb3e8",
    "string": "#8dd8bd",
    "number": "#b5b4ee",
    "shimmer": "#78dbe2",
    "shimmerEnd": "#6fb3e8"
  },
  "light": {
    "bg": "#f6f5f2",
    "fg": "#222222",
    "accent": "#157c84",
    "heading1": "#1f6aa8",
    "heading": "#126f76",
    "path": "#3f5fb0",
    "command": "#1a6a70",
    "fg2": "#444444",
    "muted": "#8a8a8a",
    "dim": "#bdbab4",
    "border": "#d2cfc8",
    "borderFocused": "#9d9a93",
    "success": "#3f8a2a",
    "error": "#c23b47",
    "warning": "#a87412",
    "thinking": "#8d7a63",
    "userBg": "#e8e6e1",
    "codeBg": "#efede9",
    "diffAddedBg": "#d6f0cf",
    "diffRemovedBg": "#f6d5d8",
    "diffAddedWordBg": "#bce5b1",
    "diffRemovedWordBg": "#edb5bd",
    "keyword": "#1f6aa8",
    "string": "#23765d",
    "number": "#6356a6",
    "shimmer": "#157c84",
    "shimmerEnd": "#1f6aa8"
  },
  "glyphs": {
    "bullets": ["*", "-", "+"],
    "codeTop": "+-",
    "codeSide": "|",
    "codeBottom": "`-",
    "image": "[]"
  }
}
```

The editor schema is [`themes.schema.json`](themes.schema.json), next to this reference. Configure your editor to associate it with theme JSON files. Runtime validation also checks terminal cell widths, which JSON Schema cannot express.

### Glyph keys and widths

`glyphs` uses flat keys from both glyph modules; do not nest `tui` or `markdown` objects. Each value is plain single-line text with no tabs, newlines or control/escape characters. `bullets` is a non-empty array, indexed by nesting depth; deeper levels repeat the last bullet.

Overrides must match the default's display-cell width, measured by Amira's text-width library, not by string length. The warning glyph may use a different width because warning layouts measure it. Terminal and font rendering may still differ; test your symbols in the terminals you use.

| Width | Keys |
| --- | --- |
| 1 cell | Each `bullets` item; `quoteBar`, `rule`, `codeSide`, `tableColumn`, `tableRule`, `tableCross`, `boxTopLeft`, `boxTopRight`, `boxBottomLeft`, `boxBottomRight`, `user`, `toolDone`, `toolRunning`, `toolFailed`, `toolInterrupted`, `toolBlocked`, `toolUnknown`, `toolInvalid`, `result`, `treeBranch`, `output`, `subagent`, `subagentDone`, `subagentFailed`, `subagentAborted`, `thought`, `question`, `dialogBar`, `choice`, `info`, `success`, `error`, `interrupted`, `more`, `pointer`, `search`, `searchPrompt`, `working`, `branch`, `separator` |
| 2 cells | `assistant` (two spaces by default), `codeTop`, `codeBottom`, `image` |
| 3 cells | `taskOpen`, `taskDone`, `checked`, `unchecked` |
| Measured separately | `warning` (two-cell emoji by default) |

For ASCII, use `image: "[]"`, `codeTop: "+-"` and ``codeBottom: "`-"`` to keep their two-cell widths. `more: "..."` is not valid: its default is one cell, so use `"."`. The built-in [`ascii.json`](../packages/cli/themes/ascii.json) is a complete ASCII glyph example.

## Package themes

A package may contribute JSON without running extension code. Paths are relative to the package directory and must stay inside it. `themes` defaults to `[]`; a theme-only package needs no `index.ts` or explicit empty `extensions` list.

`amira-package.json`:

```json
{
  "name": "my-theme-pack",
  "version": "1.0.0",
  "themes": ["themes/my-theme.json"]
}
```

Install it with `amira ext install ./my-theme-pack`, then restart or `/reload`. The same `themes` list can be placed in the `amira` object of `package.json`. Package enable/disable and project trust apply to themes as they do to other package contributions.

## Register a theme from an extension

`api.registerTheme` uses the same definition format and validation as JSON files:

```ts
import { defineExtension } from "@amira/api"

export default defineExtension((api) => {
  api.registerTheme({
    name: "extension-blue",
    description: "Blue accents with default status and surface colors",
    dark: { accent: "#8cbcff", heading1: "#a5cfff", heading: "#8cbcff", path: "#a5baff" },
    light: { accent: "#245fa8", heading1: "#1c4e8c", heading: "#245fa8", path: "#3f5fb0" },
  })
})
```

`registerTheme` returns a disposer that removes the registration immediately. Registrations belong to their extension and are removed when it unloads or reloads. Later registrations win; unloading the winner reveals the previous theme. Extension theme registration does not itself select or save the theme; choose it with `/theme` or `tui.theme`.
