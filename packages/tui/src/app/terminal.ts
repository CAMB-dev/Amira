// Owns interactive terminal selection and plain-text output for dumb terminals.
import { modelLabel } from "@amira/api"
import { ProcessTerminal, stripAnsi, type Terminal, type Theme } from "@amira/tui-kit"
import { glyphs } from "../glyphs.ts"

/** The brand is interactive accent; a working-directory reference is not. */
export function interactiveBanner(
  theme: Theme,
  model: { provider: string; id: string },
  cwd: string,
): string {
  return `${theme.accent("Amira")} ${theme.muted(`${glyphs.separator} ${modelLabel({ provider: model.provider, model: model.id })} ${glyphs.separator} `)}${theme.path(cwd)}`
}

/** No escapes, carriage returns or bell: a dumb terminal gets plain text only. */
const plain = (data: string) => stripAnsi(data).replace(/\r\n?/g, "\n").replaceAll("\x07", "")

/** Apply the same output policy to real terminals and terminals supplied by a host. */
export function interactiveTerminal(
  supplied: Terminal | undefined,
  env: Record<string, string | undefined>,
): Terminal {
  const terminal = supplied ?? new ProcessTerminal()
  if (env.TERM === "dumb") {
    if (terminal instanceof ProcessTerminal) terminal.setOutputFilter(plain)
    else {
      const write = terminal.write.bind(terminal)
      terminal.write = (data) => write(plain(data))
    }
  }
  return terminal
}
