const named: Record<string, string> = {
  enter: "\r",
  esc: "\x1b",
  escape: "\x1b",
  tab: "\t",
  backspace: "\x7f",
  space: " ",
}
const cursor: Record<string, string> = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" }
const tilde: Record<string, number> = {
  insert: 2,
  delete: 3,
  pageup: 5,
  pagedown: 6,
  f5: 15,
  f6: 17,
  f7: 18,
  f8: 19,
  f9: 20,
  f10: 21,
  f11: 23,
  f12: 24,
}

/** Arguments arrive already unquoted by the shell; quoted payloads also work in JSON clients. */
function payload(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value)
  return value
}

export function encodeKey(input: string, applicationCursor = false): string {
  if (input.startsWith("text:")) return payload(input.slice(5))
  if (input.startsWith("paste:")) return `\x1b[200~${payload(input.slice(6))}\x1b[201~`
  const parts = input.toLowerCase().split("+")
  const key = parts.pop()!
  if (new Set(parts).size !== parts.length || parts.some((p) => !["ctrl", "alt", "shift"].includes(p))) {
    throw new Error(`Unknown key: ${input}`)
  }
  const ctrl = parts.includes("ctrl")
  const alt = parts.includes("alt")
  const shift = parts.includes("shift")
  const modifier = 1 + Number(shift) + 2 * Number(alt) + 4 * Number(ctrl)
  if (cursor[key]) {
    return modifier === 1
      ? `\x1b${applicationCursor ? "O" : "["}${cursor[key]}`
      : `\x1b[1;${modifier}${cursor[key]}`
  }
  if (tilde[key]) return `\x1b[${tilde[key]}${modifier === 1 ? "" : `;${modifier}`}~`
  if (/^f[1-4]$/.test(key)) {
    const suffix = String.fromCharCode(79 + Number(key.slice(1)))
    return modifier === 1 ? `\x1bO${suffix}` : `\x1b[1;${modifier}${suffix}`
  }
  if (key === "tab" && shift && !ctrl && !alt) return "\x1b[Z"
  if (ctrl && !shift && (key.length === 1 || key === "space")) {
    const code = key === "space" ? 0 : key.charCodeAt(0) & 31
    if (key !== "space" && !/^[a-z@[\\\]^_]$/.test(key)) throw new Error(`Unknown key: ${input}`)
    return `${alt ? "\x1b" : ""}${String.fromCharCode(code)}`
  }
  if (ctrl || shift) throw new Error(`Unsupported chord: ${input}`)
  const encoded = named[key] ?? (alt && key.length === 1 ? key : undefined)
  if (encoded === undefined) throw new Error(`Unknown key: ${input}; use text: for literal text`)
  return `${alt ? "\x1b" : ""}${encoded}`
}

export function encodeKeys(inputs: string[], applicationCursor = false): string {
  return inputs.map((input) => encodeKey(input, applicationCursor)).join("")
}
