import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { modes } from "../src/ansi.ts"
import { ProcessTerminal } from "../src/terminal.ts"
import { VirtualScreen } from "./screen.ts"

/** Real terminal lifecycle on fake streams, with synchronous restore-write fault injection. */
export function processTerminalFixture() {
  const screen = new VirtualScreen(80, 24)
  let raw = false
  let failures = 0
  let restoreAttempts = 0
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (on: boolean) => {
      raw = on
    },
  })
  const stdout = Object.assign(new EventEmitter(), {
    columns: 80,
    rows: 24,
    write: (data: string) => {
      if (data.includes(modes.altScreen.off)) {
        restoreAttempts++
        if (failures > 0) {
          failures--
          throw new Error("restore write failed")
        }
      }
      screen.write(data)
      return true
    },
  })
  const terminal = new ProcessTerminal(
    stdin as unknown as NodeJS.ReadStream,
    stdout as unknown as NodeJS.WriteStream,
  )
  return {
    terminal,
    stdin,
    stdout,
    screen,
    raw: () => raw,
    restoreAttempts: () => restoreAttempts,
    failRestores: (count: number) => {
      failures = count
    },
  }
}
