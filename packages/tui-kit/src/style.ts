export type StyleFn = (text: string) => string

let colorOn = colorSupported(process.env)

/** Colors are off when `NO_COLOR` is set to a non-empty value. */
export function colorSupported(env: Record<string, string | undefined>): boolean {
  return !env.NO_COLOR
}

/** Sets the default for `RenderContext.color`, used by renderers that are not told otherwise. */
export function setColorEnabled(on: boolean): void {
  colorOn = on
}

export function isColorEnabled(): boolean {
  return colorOn
}

function sgr(open: number | string, close: number): StyleFn {
  const o = `\x1b[${open}m`
  const c = `\x1b[${close}m`
  // Re-open after nested closes so an inner style does not end the outer one.
  return (text) => o + text.replaceAll(c, c + o) + c
}

export const bold = sgr(1, 22)
export const dim = sgr(2, 22)
export const italic = sgr(3, 23)
export const underline = sgr(4, 24)
export const inverse = sgr(7, 27)

export const black = sgr(30, 39)
export const red = sgr(31, 39)
export const green = sgr(32, 39)
export const yellow = sgr(33, 39)
export const blue = sgr(34, 39)
export const magenta = sgr(35, 39)
export const cyan = sgr(36, 39)
export const white = sgr(37, 39)
export const gray = sgr(90, 39)

export const fg256 = (n: number): StyleFn => sgr(`38;5;${n}`, 39)
export const bg256 = (n: number): StyleFn => sgr(`48;5;${n}`, 49)
export const rgb = (r: number, g: number, b: number): StyleFn => sgr(`38;2;${r};${g};${b}`, 39)

export function compose(...fns: StyleFn[]): StyleFn {
  return (text) => fns.reduceRight((acc, fn) => fn(acc), text)
}

/** Semantic color tokens, so components never hardcode colors. */
export interface Theme {
  text: StyleFn
  accent: StyleFn
  muted: StyleFn
  error: StyleFn
  success: StyleFn
  warning: StyleFn
}

export const defaultTheme: Theme = {
  text: (s) => s,
  accent: cyan,
  muted: gray,
  error: red,
  success: green,
  warning: yellow,
}

/**
 * Splits SGR parameters into single attributes: `1;38;5;196` is `1` and `38;5;196`, while the
 * colon form `38:5:196` is one parameter already. An empty parameter is a reset (`0`).
 */
export function sgrAttributes(params: string): string[] {
  const parts = params.split(";")
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if ((p === "38" || p === "48" || p === "58") && (parts[i + 1] === "5" || parts[i + 1] === "2")) {
      const n = parts[i + 1] === "5" ? 2 : 4
      out.push(parts.slice(i, i + 1 + n).join(";"))
      i += n
    } else out.push(p === "" ? "0" : p)
  }
  return out
}

/** Attributes in the same group replace each other: all foreground colors are one group, and so on. */
export function sgrGroup(attr: string): string {
  const n = Number.parseInt(attr, 10)
  if ((n >= 30 && n <= 39) || (n >= 90 && n <= 97)) return "fg"
  if ((n >= 40 && n <= 49) || (n >= 100 && n <= 107)) return "bg"
  if (n === 58 || n === 59) return "ul"
  return String(n)
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching SGR sequences
const SGR_SEQUENCE = /\x1b\[([0-9;:]*)m/g

/** Removes colors from SGR sequences, keeping text attributes such as bold and underline. */
export function stripColors(s: string): string {
  if (!s.includes("\x1b[")) return s
  return s.replace(SGR_SEQUENCE, (_, params: string) => {
    const kept = sgrAttributes(params).filter((a) => {
      const g = sgrGroup(a)
      return g !== "fg" && g !== "bg" && g !== "ul"
    })
    return kept.length > 0 ? `\x1b[${kept.join(";")}m` : ""
  })
}
