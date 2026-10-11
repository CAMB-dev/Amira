import pkg from "../package.json" with { type: "json" }

declare const AMIRA_VERSION: string | undefined
declare const AMIRA_CHANNEL: string | undefined
declare const AMIRA_TARGET: string | undefined

export const version = typeof AMIRA_VERSION === "string" ? AMIRA_VERSION : pkg.version
export const channel = typeof AMIRA_CHANNEL === "string" ? AMIRA_CHANNEL : "stable"
export const target =
  typeof AMIRA_TARGET === "string"
    ? AMIRA_TARGET
    : `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`

export const versionLine = `${version} (${channel}, ${target})`
