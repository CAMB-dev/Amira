// Owns interactive terminal selection and fullscreen lifecycle cleanup.
import {
  clipMiddle,
  DEFAULT_TUI_BELL,
  DEFAULT_TUI_PROGRESS,
  DEFAULT_TUI_TITLE,
  modelLabel,
  type TuiSettings,
} from "@amira/api"
import { ProcessTerminal, type Terminal, type Theme, visibleWidth } from "@amira/tui-kit"
import { glyphs, viewEllipsis } from "../glyphs.ts"
import { TerminalStatus } from "../terminal-status.ts"

export function createTerminalStatus(
  terminal: Terminal,
  settings: TuiSettings,
  env: Record<string, string | undefined>,
): TerminalStatus {
  return new TerminalStatus(
    terminal,
    {
      title: settings.title ?? DEFAULT_TUI_TITLE,
      progress: settings.progress ?? DEFAULT_TUI_PROGRESS,
      bell: settings.bell ?? DEFAULT_TUI_BELL,
      notify: settings.notify,
    },
    env,
  )
}

/**
 * The brand is interactive accent; a working-directory reference is not. A cwd that does not
 * fit after the model goes on a row of its own, cut in its middle, so no separator is left at
 * a row's end and no path breaks mid-segment.
 */
export function interactiveBanner(
  theme: Theme,
  model: { provider: string; id: string },
  cwd: string,
  width = Number.POSITIVE_INFINITY,
): string {
  const head = `Amira ${glyphs.separator} ${modelLabel({ provider: model.provider, model: model.id })}`
  const brand = `${theme.accent("Amira")} ${theme.muted(head.slice("Amira ".length))}`
  if (visibleWidth(`${head} ${glyphs.separator} ${cwd}`) <= width)
    return `${brand}${theme.muted(` ${glyphs.separator} `)}${theme.path(cwd)}`
  return `${brand}\n${theme.path(clipMiddle(cwd, Math.max(1, width), viewEllipsis()))}`
}

/**
 * Guard the whole interactive lifecycle, including setup before the app's quit handler exists.
 * Dumb terminals are rejected without emitting escapes; failures always suggest plain output.
 */
export async function withFullscreenTerminal<T>(
  terminal: Terminal,
  env: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  if (env.TERM === "dumb") {
    throw new Error('TERM=dumb cannot run the fullscreen UI; use amira -p "<prompt>" for plain output.')
  }
  try {
    return await run()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Cannot run the fullscreen UI: ${message}; use amira -p "<prompt>" for plain output.`, {
      cause: error,
    })
  } finally {
    // A transient output failure gets one retry; cleanup must not replace the startup error.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (terminal instanceof ProcessTerminal) terminal.stop()
        else terminal.restore()
        break
      } catch {}
    }
    try {
      terminal.setRawMode(false)
    } catch {}
  }
}
