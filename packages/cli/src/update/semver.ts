export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

export function parseVersion(value: string): ParsedVersion | undefined {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    )
  if (!match || match[0] !== value) return undefined
  const parts = match.slice(1, 4).map(Number)
  const prerelease = match[4]?.split(".") ?? []
  if (parts.some((part) => !Number.isSafeInteger(part)) || prerelease.some((part) => /^0\d+$/.test(part)))
    return undefined
  return { major: parts[0]!, minor: parts[1]!, patch: parts[2]!, prerelease }
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) throw new Error("Invalid update version")
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1
  }
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const x = left.prerelease[i]
    const y = right.prerelease[i]
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1
    if (x === y) continue
    const numericX = /^\d+$/.test(x)
    const numericY = /^\d+$/.test(y)
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1
    if (numericX !== numericY) return numericX ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

export function isPatchUpdate(current: string, next: string): boolean {
  const a = parseVersion(current)
  const b = parseVersion(next)
  return !!a && !!b && a.major === b.major && a.minor === b.minor && compareVersions(next, current) > 0
}

export function isReleaseVersion(version: string): boolean {
  const parsed = parseVersion(version)
  return (
    !!parsed &&
    !(parsed.major === 0 && parsed.minor === 0 && parsed.patch === 0) &&
    !parsed.prerelease.some((part) => part.toLowerCase() === "dev")
  )
}
