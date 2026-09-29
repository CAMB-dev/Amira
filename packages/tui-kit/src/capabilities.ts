import { modes, queries } from "./ansi.ts"
import type { CellSize, ImageProtocol } from "./images/types.ts"
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
  if (env.TMUX || env.STY || env.TERM === "dumb") return false
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
  /**
   * Whether the terminal's background is dark or light, when asked (`setupTerminalInput`'s
   * `background`): from its answer to OSC 11, else from COLORFGBG. Unset when neither says.
   */
  background?: Background
}

/** A terminal background, as far as colors drawn on it are concerned. */
export type Background = "dark" | "light"

/** An RGB color, each channel from 0 to 1. */
export interface Rgb {
  r: number
  g: number
  b: number
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
  /** OSC 11: the default background color. */
  background?: Rgb
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
/** Any reply to an OSC query, whether this reads its form or not: never input. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
const OSC_REPLY = /\x1b\]\d+;[^\x07\x1b]*(?:\x07|\x1b\\)/g
/** OSC 11 with `rgb:` and 1 to 4 hex digits a channel, ended by BEL or ST. */
const BACKGROUND_REPLY =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
  /\x1b\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})[^\x07\x1b]*(?:\x07|\x1b\\)/gi
/** The start of a reply not finished yet: CSI parameters, or an APC or OSC string. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
const PARTIAL_SEQUENCE = /\x1b(?:\[[ -?]*|[_\]][^\x07\x1b]*\x1b?)?$/

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
      .replace(KITTY_GRAPHICS_REPLY, "")
      .replace(OSC_REPLY, ""),
  }
  for (const m of data.matchAll(BACKGROUND_REPLY)) {
    const channel = (hex: string) => Number.parseInt(hex, 16) / (16 ** hex.length - 1)
    out.background = { r: channel(m[1]!), g: channel(m[2]!), b: channel(m[3]!) }
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
  /** Also ask for the default background color (OSC 11). */
  background?: boolean
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
        (opts.background ? queries.background : "") +
        queries.primaryDeviceAttributes,
    )
  })
}

/** Dark or light, by the color's perceived brightness. */
export function backgroundOf(c: Rgb): Background {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b < 0.5 ? "dark" : "light"
}

/**
 * The background COLORFGBG names (`15;0`, `0;default;15`: the last field is the background's
 * ANSI color), set by rxvt, Konsole and some others. Colors 7 and 9 to 15 are light.
 */
export function backgroundFromEnv(env: Env = process.env): Background | undefined {
  const last = env.COLORFGBG?.split(";").at(-1)
  if (!last || !/^\d+$/.test(last)) return undefined
  const n = Number(last)
  if (n > 15) return undefined
  return n === 7 || n >= 9 ? "light" : "dark"
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
 * With `background`, it also asks for the background color, for `capabilities.background`.
 */
export async function setupTerminalInput(
  term: Terminal,
  env: Env = process.env,
  opts: { timeoutMs?: number; images?: boolean; background?: boolean } = {},
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
    background: !!opts.background,
  })
  const background = opts.background
    ? probe.background
      ? backgroundOf(probe.background)
      : backgroundFromEnv(env)
    : undefined
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
      ...(background ? { background } : {}),
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
 * Windows Terminal (also under WSL) draws Sixel at a fixed virtual cell of 10×20 pixels;
 * elsewhere the reported cell size is used. Without one, Sixel is left out on "auto"; otherwise
 * 10×20 (VS Code) or 8×16 is assumed.
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
  // Windows Terminal also behind WSL, which gets WT_SESSION too (not VS Code: it uses iTerm2's).
  const wt = !!env.WT_SESSION && !info.vscode
  const virtual = { width: 10, height: 20 }
  if (protocol === "sixel" && wt) return { protocol, cell: virtual }
  if (graphics?.cell) return { protocol, cell: graphics.cell }
  // Sixel at a guessed cell size would reserve the wrong number of rows: only when asked for.
  if (protocol === "sixel" && setting === "auto") return undefined
  return { protocol, cell: info.vscode ? virtual : { width: 8, height: 16 } }
}
