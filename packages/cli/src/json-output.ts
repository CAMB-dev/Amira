/** JSON.stringify that never throws: BigInts become strings, cycles and failures are marked. */
export function safeJson(value: unknown): string {
  try {
    // The objects being written, outermost first: a value among them is a cycle. One reached
    // twice by different paths (e.g. one model named in two fields) is not, and is written both times.
    const path: object[] = []
    const json = JSON.stringify(value, function (this: unknown, _k, v) {
      if (typeof v === "bigint") return v.toString()
      if (v && typeof v === "object") {
        while (path.length && path[path.length - 1] !== this) path.pop()
        if (path.includes(v)) return "[circular]"
        path.push(v)
      }
      return v
    })
    return asciiJson(json ?? "null")
  } catch (err) {
    return asciiJson(
      JSON.stringify({ unserializable: true, error: err instanceof Error ? err.message : String(err) }),
    )
  }
}

/** JSON lines stay ASCII so a Windows parent cannot reinterpret UTF-8 as an OEM code page. */
function asciiJson(json: string): string {
  let result = ""
  for (let index = 0; index < json.length; index++) {
    const character = json[index]
    const code = json.charCodeAt(index)
    result += code <= 0x7f ? character : `\\u${code.toString(16).padStart(4, "0")}`
  }
  return result
}
