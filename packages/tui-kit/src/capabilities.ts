import { modes, queries } from "./ansi.ts"
import { hasInputReader } from "./reader.ts"
import type { Terminal } from "./terminal.ts"

type Env = Record<string, string | undefined>

export interface TerminalEnv {
  windowsTerminal: boolean
  vscode: boolean
}

/**
 * Windows Terminal is recognized by WT_SESSION, which is also inherited by whatever runs inside
 * it: VS Code, tmux and WSL each get their own terminal handling, so they do not count.
 */
export function detectEnv(env: Env = process.env): TerminalEnv {
  const vscode = env.TERM_PROGRAM === "vscode"
  const nested = vscode || !!env.TMUX || !!env.WSL_DISTRO_NAME
  return { vscode, windowsTerminal: !!env.WT_SESSION && !nested }
}

export interface Capabilities {
  win32InputMode: boolean
  kittyKeyboard: boolean
  synchronizedOutput: boolean
  /** Whether Shift+Enter can be told apart from Enter. */
  shiftEnter: boolean
}

export interface ProbeReplies {
  kittyKeyboard: boolean
  synchronizedOutput: boolean
  /** The terminal answered the final DA1 query, so every earlier reply is in. */
  complete: boolean
  /** Input that was not a reply (keys typed while probing). */
  rest: string
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
const KITTY_REPLY = /\x1b\[\?\d+u/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
const SYNC_REPLY = /\x1b\[\?2026;(\d+)\$y/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
const DA1_REPLY = /\x1b\[\?[\d;]*c/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
const PARTIAL_SEQUENCE = /\x1b(?:\[[ -?]*)?$/

/** Reads replies to the kitty keyboard, DECRQM 2026 and DA1 queries out of raw input. */
export function parseProbeReplies(data: string): ProbeReplies {
  const syncModes = Array.from(data.matchAll(SYNC_REPLY), (m) => m[1])
  return {
    kittyKeyboard: data.match(KITTY_REPLY) !== null,
    synchronizedOutput: syncModes.some((n) => n === "1" || n === "2"),
    complete: data.match(DA1_REPLY) !== null,
    rest: data.replace(KITTY_REPLY, "").replace(SYNC_REPLY, "").replace(DA1_REPLY, ""),
  }
}

export interface ProbeOptions {
  kittyKeyboard?: boolean
  timeoutMs?: number
  /** Extra time given to a reply that has started but not finished when `timeoutMs` is up. */
  lateReplyMs?: number
}

/**
 * Asks the terminal what it supports. A DA1 query goes last: almost every terminal answers it,
 * so its reply means the others are in. Otherwise we give up after `timeoutMs`, unless a reply
 * is half in: then it gets `lateReplyMs` more. A reply cut short is never returned in `rest`.
 */
export function probeTerminal(term: Terminal, opts: ProbeOptions = {}): Promise<ProbeReplies> {
  const { kittyKeyboard = true, timeoutMs = 300, lateReplyMs = 500 } = opts
  return new Promise((resolve) => {
    let data = ""
    const finish = () => {
      clearTimeout(timer)
      off()
      const replies = parseProbeReplies(data)
      resolve({ ...replies, rest: replies.rest.replace(PARTIAL_SEQUENCE, "") })
    }
    const off = term.onInput((chunk) => {
      data += chunk
      if (parseProbeReplies(data).complete) finish()
    })
    let timer = setTimeout(() => {
      if (PARTIAL_SEQUENCE.test(data)) timer = setTimeout(finish, lateReplyMs)
      else finish()
    }, timeoutMs)
    term.write(
      (kittyKeyboard ? queries.kittyKeyboard : "") + queries.syncOutput + queries.primaryDeviceAttributes,
    )
  })
}

export interface SetupResult {
  capabilities: Capabilities
  /** Input typed during probing; feed it to the input reader. */
  leftoverInput: string
}

/**
 * Probes the terminal and enables the best keyboard input mode it has, plus bracketed paste.
 * win32-input-mode is used only in Windows Terminal: VS Code also speaks it but drops every
 * modifier bit. Switches the terminal to raw mode first, since the replies cannot be read
 * otherwise. Everything enabled here, raw mode included, is undone by `terminal.restore()`.
 * Must run before an `InputReader` is started, or keys typed while probing would arrive twice.
 */
export async function setupTerminalInput(
  term: Terminal,
  env: Env = process.env,
  opts: { timeoutMs?: number } = {},
): Promise<SetupResult> {
  if (hasInputReader(term)) throw new Error("setupTerminalInput must run before an InputReader is started")
  term.setRawMode(true)
  const info = detectEnv(env)
  const win32InputMode = info.windowsTerminal
  const probe = await probeTerminal(term, { kittyKeyboard: !win32InputMode, timeoutMs: opts.timeoutMs })
  const kittyKeyboard = !win32InputMode && probe.kittyKeyboard
  term.enableMode(modes.bracketedPaste)
  if (win32InputMode) term.enableMode(modes.win32Input)
  else if (kittyKeyboard) term.enableMode(modes.kittyKeyboard)
  return {
    capabilities: {
      win32InputMode,
      kittyKeyboard,
      synchronizedOutput: probe.synchronizedOutput,
      shiftEnter: win32InputMode || kittyKeyboard,
    },
    leftoverInput: probe.rest,
  }
}
