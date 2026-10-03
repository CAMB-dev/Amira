import { closeStyles, tokenize } from "../width.ts"
import type { Run } from "./inline.ts"

/** Styled callback text becomes ordinary runs so ANSI bytes never count towards wrapping. */
export function mathRuns(text: string, at: number, end: number, carry: string): Run[] {
  const runs: Run[] = []
  let prefix = ""
  let value = ""
  const flush = () => {
    if (!value) return
    const styles = prefix
    runs.push({
      text: value,
      src: at,
      carry,
      cuttable: false,
      rest: { url: false, resume: end },
      ...(styles ? { style: (s: string) => closeStyles(styles + s) } : {}),
    })
    value = ""
  }
  for (const token of tokenize(text)) {
    if (token.ansi) {
      flush()
      prefix += token.text
    } else value += token.text.replaceAll("\n", " ")
  }
  flush()
  return runs
}
