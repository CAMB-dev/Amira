export type StyleFn = (text: string) => string

let colorOn = colorSupported(process.env)

/** Colors are off when `NO_COLOR` is set to a non-empty value. */
export function colorSupported(env: Record<string, string | undefined>): boolean {
  return !env.NO_COLOR
}

export function setColorEnabled(on: boolean): void {
  colorOn = on
}

export function isColorEnabled(): boolean {
  return colorOn
}

function sgr(open: number | string, close: number, isColor: boolean): StyleFn {
  const o = `\x1b[${open}m`
  const c = `\x1b[${close}m`
  return (text) => {
    if (isColor && !colorOn) return text
    // Re-open after nested closes so an inner style does not end the outer one.
    return o + text.replaceAll(c, c + o) + c
  }
}

export const bold = sgr(1, 22, false)
export const dim = sgr(2, 22, false)
export const italic = sgr(3, 23, false)
export const underline = sgr(4, 24, false)
export const inverse = sgr(7, 27, false)

export const black = sgr(30, 39, true)
export const red = sgr(31, 39, true)
export const green = sgr(32, 39, true)
export const yellow = sgr(33, 39, true)
export const blue = sgr(34, 39, true)
export const magenta = sgr(35, 39, true)
export const cyan = sgr(36, 39, true)
export const white = sgr(37, 39, true)
export const gray = sgr(90, 39, true)

export const fg256 = (n: number): StyleFn => sgr(`38;5;${n}`, 39, true)
export const bg256 = (n: number): StyleFn => sgr(`48;5;${n}`, 49, true)
export const rgb = (r: number, g: number, b: number): StyleFn => sgr(`38;2;${r};${g};${b}`, 39, true)

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
