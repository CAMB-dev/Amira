import { expect, test } from "bun:test"
import * as api from "../src/index.ts"

test("the package exports its public API and not its internals", () => {
  for (const name of [
    "LiveRenderer",
    "InputReader",
    "ProcessTerminal",
    "Editor",
    "setupTerminalInput",
    "wrapText",
    "InputParser",
    "BaseTerminal",
    "key",
    "textKey",
    "graphemes",
    "stripColors",
    "TAB_WIDTH",
  ]) {
    expect(api).toHaveProperty(name)
  }
  for (const name of ["tokenize", "sgrAttributes", "probeTerminal", "cursor"]) {
    expect(api).not.toHaveProperty(name)
  }
})
