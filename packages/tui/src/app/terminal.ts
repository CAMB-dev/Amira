// Owns interactive terminal selection and fullscreen lifecycle cleanup.
import {
  DEFAULT_TUI_BELL,
  DEFAULT_TUI_PROGRESS,
  DEFAULT_TUI_TITLE,
  modelLabel,
  type TuiSettings,
} from "@amira/api"
import { ProcessTerminal, type Terminal, type Theme } from "@amira/tui-kit"
import { glyphs } from "../glyphs.ts"
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

/** The brand is interactive accent; a working-directory reference is not. */
export function interactiveBanner(
  theme: Theme,
  model: { provider: string; id: string },
  cwd: string,
): string {
  return `${theme.accent("Amira")} ${theme.muted(`${glyphs.separator} ${modelLabel({ provider: model.provider, model: model.id })} ${glyphs.separator} `)}${theme.path(cwd)}`
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
