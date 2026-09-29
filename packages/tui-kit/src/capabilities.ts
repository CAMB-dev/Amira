import { modes, queries } from "./ansi.ts"
import type { ImageProtocol } from "./images/encode.ts"
import type { CellSize } from "./images/fit.ts"
import { hasInputReader } from "./reader.ts"
import { ProcessTerminal, type Terminal } from "./terminal.ts"

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

/**
 * Whether the terminal turns OSC 8 sequences into clickable links; terminals that do not
 * support them mostly ignore them, but some print them. `FORCE_HYPERLINK=1` or `=0` overrides.
 */
export function supportsHyperlinks(env: Env = process.env): boolean {
  const force = env.FORCE_HYPERLINK
  if (force !== undefined && force !== "") return force !== "0"
  if (env.TMUX || env.STY) return false
  if (env.WT_SESSION) return true
  const program = env.TERM_PROGRAM ?? ""
  if (["vscode", "iTerm.app", "WezTerm", "ghostty", "Hyper"].includes(program)) return true
  const term = env.TERM ?? ""
  if (/kitty|alacritty|foot|wezterm|ghostty/.test(term)) return true
  return Number.parseInt(env.VTE_VERSION ?? "", 10) >= 5000
}

export interface Capabilities {
  win32InputMode: boolean
  kittyKeyboard: boolean
  synchronizedOutput: boolean
  /** Whether Shift+Enter can be told apart from Enter. */
  shiftEnter: boolean
  /** What the terminal said about graphics, when asked (`setupTerminalInput`'s `images`). */
  graphics?: GraphicsReplies
}

/** The terminal's answers about graphics. */
export interface GraphicsReplies {
  /** The terminal answered the probe at all (DA1). */
  answered: boolean
  /** DA1 lists Sixel (attribute 4). */
  sixel: boolean
  /** It answered the kitty graphics query with OK. */
  kitty: boolean
  /** The size of a cell in pixels, from XTWINOPS 16 (or 14 divided by the size in cells). */
  cell?: CellSize
}

export interface ProbeReplies {
  kittyKeyboard: boolean
  synchronizedOutput: boolean
  /** The terminal answered the final DA1 query, so every earlier reply is in. */
  complete: boolean
  /** Input that was not a reply (keys typed while probing). */
  rest: string
  /** The attributes in the DA1 reply (62, 4, 22, ...). */
  attributes?: number[]
  /** XTWINOPS 16: a cell's size in pixels. */
  cellPixels?: CellSize
  /** XTWINOPS 14: the text area's size in pixels. */
  windowPixels?: CellSize
  /** The kitty graphics query was answered: true when with OK. */
  kittyGraphics?: boolean
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
const KITTY_REPLY = /\x1b\[\?\d+u/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
const SYNC_REPLY = /\x1b\[\?2026;(\d+)\$y/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
const DA1_REPLY = /\x1b\[\?([\d;]*)c/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
const PIXELS_REPLY = /\x1b\[([46]);(\d+);(\d+)t/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
const KITTY_GRAPHICS_REPLY = /\x1b_Gi=31;([^\x1b]*)\x1b\\/g
/** The start of a reply not finished yet: CSI parameters, or an APC string. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
const PARTIAL_SEQUENCE = /\x1b(?:\[[ -?]*|_[^\x1b]*\x1b?)?$/

/**
 * Reads replies to the kitty keyboard, DECRQM 2026 and DA1 queries, and to the graphics ones
 * (XTWINOPS 14 and 16, kitty graphics), out of raw input.
 */
export function parseProbeReplies(data: string): ProbeReplies {
  const syncModes = Array.from(data.matchAll(SYNC_REPLY), (m) => m[1])
  const out: ProbeReplies = {
    kittyKeyboard: data.match(KITTY_REPLY) !== null,
    synchronizedOutput: syncModes.some((n) => n === "1" || n === "2"),
    complete: false,
    rest: data
      .replace(KITTY_REPLY, "")
      .replace(SYNC_REPLY, "")
      .replace(DA1_REPLY, "")
      .replace(PIXELS_REPLY, "")
      .replace(KITTY_GRAPHICS_REPLY, ""),
  }
  for (const m of data.matchAll(DA1_REPLY)) {
    out.complete = true
    out.attributes = m[1]!.split(";").filter(Boolean).map(Number)
  }
  for (const m of data.matchAll(PIXELS_REPLY)) {
    const size = { height: Number(m[2]), width: Number(m[3]) }
    if (size.width < 1 || size.height < 1) continue
    if (m[1] === "6") out.cellPixels = size
    else out.windowPixels = size
  }
  for (const m of data.matchAll(KITTY_GRAPHICS_REPLY)) out.kittyGraphics = m[1] === "OK"
  return out
}

export interface ProbeOptions {
  kittyKeyboard?: boolean
  /** Also ask for the cell size in pixels (XTWINOPS 16 and 14). */
  pixels?: boolean
  /** Also send the kitty graphics query; an APC string, which some terminals print. */
  kittyGraphics?: boolean
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
      (kittyKeyboard ? queries.kittyKeyboard : "") +
        queries.syncOutput +
        (opts.pixels ? queries.cellPixels + queries.windowPixels : "") +
        (opts.kittyGraphics ? queries.kittyGraphics : "") +
        queries.primaryDeviceAttributes,
    )
  })
}

/** Terminals that may speak the kitty graphics protocol, the only ones sent its query. */
export function mayHaveKittyGraphics(env: Env = process.env): boolean {
  const program = env.TERM_PROGRAM ?? ""
  return (
    !!env.KITTY_WINDOW_ID ||
    /kitty|ghostty/.test(env.TERM ?? "") ||
    program === "ghostty" ||
    program === "WezTerm" ||
    !!env.WEZTERM_EXECUTABLE
  )
}

/** What the probe said about graphics, with the cell size from XTWINOPS 16, else 14. */
function graphicsOf(probe: ProbeReplies, term: Terminal): GraphicsReplies {
  const out: GraphicsReplies = {
    answered: probe.complete,
    sixel: probe.attributes?.includes(4) ?? false,
    kitty: !!probe.kittyGraphics,
  }
  const win = probe.windowPixels
  if (probe.cellPixels) out.cell = probe.cellPixels
  else if (win && term.columns > 0 && term.rows > 0) {
    const cell = { width: Math.floor(win.width / term.columns), height: Math.floor(win.height / term.rows) }
    if (cell.width > 0 && cell.height > 0) out.cell = cell
  }
  return out
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
 * A `ProcessTerminal` that was not started yet is started here, since the replies arrive as
 * input; stopping it stays with the caller. With `images`, it also asks about graphics (the
 * cell size in pixels, and kitty graphics where that may be there) for `capabilities.graphics`.
 */
export async function setupTerminalInput(
  term: Terminal,
  env: Env = process.env,
  opts: { timeoutMs?: number; images?: boolean } = {},
): Promise<SetupResult> {
  if (hasInputReader(term)) throw new Error("setupTerminalInput must run before an InputReader is started")
  if (term instanceof ProcessTerminal) term.start()
  term.setRawMode(true)
  const info = detectEnv(env)
  const win32InputMode = info.windowsTerminal
  const probe = await probeTerminal(term, {
    kittyKeyboard: !win32InputMode,
    timeoutMs: opts.timeoutMs,
    pixels: !!opts.images,
    kittyGraphics: !!opts.images && mayHaveKittyGraphics(env),
  })
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
      ...(opts.images ? { graphics: graphicsOf(probe, term) } : {}),
    },
    leftoverInput: probe.rest,
  }
}

/** Whether Markdown images are drawn: "auto" where the terminal says it can, "on" everywhere. */
export type ImageSetting = "auto" | "on" | "off"

/** How images are drawn here: the protocol and the cell size to fit them with. */
export interface ImageSupport {
  protocol: ImageProtocol
  cell: CellSize
}

/**
 * Picks how to draw images. The kitty protocol where the terminal answered its query; iTerm2's
 * in iTerm2 and WezTerm (once the terminal answered at all), and in VS Code when DA1 lists Sixel
 * (the image addon of `terminal.integrated.enableImages` does both, and this keeps full color);
 * Sixel wherever DA1 lists it, which Windows Terminal does from 1.22. "on" guesses where the
 * probe found nothing; tmux and screen get none on "auto", since they would need passthrough.
 * Windows Terminal draws Sixel at a fixed virtual cell of 10×20 pixels; elsewhere the reported
 * cell size is used, or 10×20 (VS Code) or 8×16 when none came.
 */
export function chooseImageSupport(
  setting: ImageSetting,
  graphics: GraphicsReplies | undefined,
  env: Env = process.env,
): ImageSupport | undefined {
  if (setting === "off") return undefined
  if (setting === "auto" && (env.TMUX || env.STY)) return undefined
  const info = detectEnv(env)
  const program = env.TERM_PROGRAM ?? ""
  let protocol: ImageProtocol | undefined
  if (graphics?.kitty) protocol = "kitty"
  else if ((program === "iTerm.app" || program === "WezTerm") && graphics?.answered) protocol = "iterm2"
  else if (graphics?.sixel) protocol = info.vscode ? "iterm2" : "sixel"
  else if (setting === "on") {
    protocol =
      program === "iTerm.app" || program === "WezTerm" || info.vscode
        ? "iterm2"
        : mayHaveKittyGraphics(env)
          ? "kitty"
          : "sixel"
  }
  if (!protocol) return undefined
  const fallback = info.windowsTerminal || info.vscode ? { width: 10, height: 20 } : { width: 8, height: 16 }
  const cell = protocol === "sixel" && info.windowsTerminal ? fallback : (graphics?.cell ?? fallback)
  return { protocol, cell }
}
