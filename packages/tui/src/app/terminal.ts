// Owns interactive terminal selection and plain-text output for dumb terminals.
import { ProcessTerminal, stripAnsi, type Terminal } from "@amira/tui-kit"

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
