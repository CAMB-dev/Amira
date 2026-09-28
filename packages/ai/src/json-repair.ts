const PYTHON_LITERALS: Record<string, string> = { True: "true", False: "false", None: "null" }
const JSON_LITERALS = new Set(["true", "false", "null"])
const ESCAPED: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" }

/**
 * Repairs the JSON object mistakes models make in tool arguments: code fences, text before the
 * object, single quotes, unquoted keys, trailing commas, raw newlines in strings and missing
 * closing brackets. Returns undefined when the text cannot be read without guessing, such as
 * a string cut off midway, since running a tool with truncated content would do harm.
 */
export function repairJsonObject(raw: string): Record<string, unknown> | undefined {
  let text = stripFence(raw.trim())
  const start = text.indexOf("{")
  if (start < 0) return undefined
  text = text.slice(start)

  let out = ""
  const stack: string[] = []
  let quote: string | undefined
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (escaped) {
        out += quote === "'" && ch === "'" ? "'" : `\\${ch}`
        escaped = false
      } else if (ch === "\\") escaped = true
      else if (ch === quote) {
        out += '"'
        quote = undefined
      } else if (ch === '"') out += '\\"'
      else out += ESCAPED[ch] ?? ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += '"'
    } else if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]")
      out += ch
    } else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return undefined
      out = out.replace(/,\s*$/, "") + ch
      // Anything after the outermost object is prose or junk.
      if (stack.length === 0) break
    } else if (/[A-Za-z_$]/.test(ch)) {
      const word = /^[A-Za-z_$][\w$]*/.exec(text.slice(i))![0]
      const rest = text.slice(i + word.length)
      if (stack.at(-1) === "}" && /[{,]\s*$/.test(out) && /^\s*:/.test(rest)) out += JSON.stringify(word)
      else if (JSON_LITERALS.has(word)) out += word
      else if (PYTHON_LITERALS[word]) out += PYTHON_LITERALS[word]
      else return undefined
      i += word.length - 1
    } else out += ch
  }
  if (quote) return undefined
  out = out.replace(/,\s*$/, "")
  if (/:\s*$/.test(out)) return undefined
  while (stack.length) out += stack.pop()
  try {
    const v = JSON.parse(out)
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined
  } catch {
    return undefined
  }
}

/** The body of a ```json fenced block, closed or not; other text is returned unchanged. */
function stripFence(text: string): string {
  const m = /^```[\w-]*[ \t]*\r?\n?([\s\S]*?)(?:\r?\n?```\s*)?$/.exec(text)
  return m ? m[1]!.trim() : text
}
