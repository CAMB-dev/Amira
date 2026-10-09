/** Replaces/adds top-level values without rewriting unrelated JSON. Input must be valid JSON. */
export function editJsonValues(
  text: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string {
  // Removal is not used for remembered choices; other settings callers keep the normal writer.
  if (Object.keys(before).some((key) => !Object.hasOwn(after, key))) {
    return `${JSON.stringify(after, null, 2)}\n`
  }
  const tokens = [...text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],:]|[^\s{}[\],:]+/g)]
  const edits: { start: number; end: number; value: string }[] = []
  const found = new Set<string>()
  let depth = 0
  let close = text.length
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const value = token[0]
    if (value === "{" || value === "[") depth++
    else if (value === "}" || value === "]") {
      depth--
      if (depth === 0) close = token.index
    } else if (depth === 1 && value.startsWith('"') && tokens[i + 1]?.[0] === ":") {
      const key: string = JSON.parse(value)
      found.add(key)
      const start = tokens[i + 2]!.index
      let end = start
      let nested = 0
      i += 2
      for (; i < tokens.length; i++) {
        const part = tokens[i]!
        if (nested === 0 && (part[0] === "," || part[0] === "}")) break
        if (part[0] === "{" || part[0] === "[") nested++
        else if (part[0] === "}" || part[0] === "]") nested--
        end = part.index + part[0].length
      }
      i--
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        edits.push({ start, end, value: JSON.stringify(after[key]) })
      }
    }
  }
  const added = Object.keys(after).filter((key) => !found.has(key))
  if (added.length) {
    const newline = text.includes("\r\n") ? "\r\n" : "\n"
    const indent = /(?:\r?\n)([\t ]+)"/.exec(text)?.[1] ?? "  "
    const multiline = text.includes("\n")
    // Insert before the trailing whitespace, leaving the closing brace and its indent alone.
    const at = text.slice(0, close).trimEnd().length
    const separator = multiline ? `${newline}${indent}` : " "
    const values = added.map((key) => `${JSON.stringify(key)}: ${JSON.stringify(after[key])}`)
    edits.push({
      start: at,
      end: at,
      value: `${found.size ? "," : ""}${separator}${values.join(`,${separator}`)}`,
    })
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.value + text.slice(edit.end)
  }
  return text
}
