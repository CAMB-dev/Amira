// Flat entrypoints preserve relative Worker URLs in the compiled virtual filesystem.
// Early diagnostics deliberately do not import the server composition root or settings.
import pkg from "../../packages/cli/package.json" with { type: "json" }

declare const AMIRA_VERSION: string | undefined
declare const AMIRA_CHANNEL: string | undefined
declare const AMIRA_TARGET: string | undefined
declare const AMIRA_SERVER_BUILD_ID: string | undefined

const version = typeof AMIRA_VERSION === "string" ? AMIRA_VERSION : pkg.version
const channel = typeof AMIRA_CHANNEL === "string" ? AMIRA_CHANNEL : "stable"
const target =
  typeof AMIRA_TARGET === "string"
    ? AMIRA_TARGET
    : `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
const buildId =
  typeof AMIRA_SERVER_BUILD_ID === "string"
    ? AMIRA_SERVER_BUILD_ID
    : process.env.AMIRA_SERVER_BUILD_ID || "development-unverified"
const argv = process.argv.slice(2)

try {
  if (argv.length === 1 && argv[0] === "--version") {
    console.log(`${version} (${channel}, ${target}; amira-server)`)
  } else if (argv.length === 1 && argv[0] === "--version-json") {
    console.log(JSON.stringify({ product: "amira-server", version, channel, target, buildId }))
  } else if (argv.length === 1 && argv[0] === "--self-check") {
    const { serverSelfCheck } = await import("./server-self-check.ts")
    const result = await serverSelfCheck()
    console.log(JSON.stringify({ ...result, product: "amira-server", version, channel, target, buildId }))
    if (!result.ok) process.exitCode = 1
  } else {
    const { serverMain } = await import("../../packages/cli/src/server-main.ts")
    process.exitCode = await serverMain(argv)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
