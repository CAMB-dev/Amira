const cache = new Map<number, readonly string[]>()

/** JSON's shortest spelling can differ from the full decimal or exact integer value. */
export function modelNumericForms(value: number): readonly string[] {
  const cached = cache.get(value)
  if (cached) return cached
  const canonical = String(value)
  const forms = new Set([canonical])
  if (canonical.includes("e")) {
    const [coefficient = "", exponent = "0"] = canonical.split("e")
    const sign = coefficient.startsWith("-") ? "-" : ""
    const unsigned = coefficient.replace(/^-/, "")
    const digits = unsigned.replace(".", "")
    const point = (unsigned.includes(".") ? unsigned.indexOf(".") : unsigned.length) + Number(exponent)
    forms.add(
      sign +
        (point <= 0
          ? `0.${"0".repeat(-point)}${digits}`
          : point >= digits.length
            ? digits + "0".repeat(point - digits.length)
            : `${digits.slice(0, point)}.${digits.slice(point)}`),
    )
  }
  if (Number.isInteger(value)) forms.add(BigInt(value).toString())
  const result = Object.freeze([...forms])
  if (cache.size >= 4096) cache.delete(cache.keys().next().value!)
  cache.set(value, result)
  return result
}
