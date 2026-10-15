#!/usr/bin/env node
// This template is copied into a CommonJS package; keep it compatible with Node 18 and Bun.
const { spawn } = require("node:child_process")

const releases = "https://github.com/CAMB-dev/Amira/releases"
// Replaced with the shared npm platform table by npm-pack.ts; no runtime dependency.
const platforms = /* AMIRA_NPM_PLATFORMS */ []

let binary = process.env.AMIRA_BINARY
if (!binary) {
  const platform = `${process.platform}-${process.arch}`
  const selected = platforms.find((entry) => entry.os === process.platform && entry.cpu === process.arch)
  const name = selected ? selected.name : `amira-${platform}`
  if (!selected) {
    console.error(
      `Amira does not support ${platform} (no ${name} package). Check GitHub Releases for alternatives: ${releases}`,
    )
    process.exit(1)
  }
  try {
    binary = require.resolve(`${name}/bin/amira${process.platform === "win32" ? ".exe" : ""}`)
  } catch {
    console.error(
      `Amira could not find ${name}. Reinstall amira with optional dependencies enabled, or download a binary: ${releases}`,
    )
    process.exit(1)
  }
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" })
// Console interrupts already reach the child. Windows child.kill("SIGINT") would
// terminate it outright; POSIX terminal delivery would otherwise happen twice.
const consoleSignals = process.platform === "win32" ? ["SIGINT", "SIGBREAK"] : ["SIGINT", "SIGQUIT"]
const ignoreConsole =
  process.platform === "win32" || !!(process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY)
const signals = ["SIGTERM", "SIGHUP", ...consoleSignals]
const handlers = new Map()
for (const signal of signals) {
  const handler = () => {
    if (!ignoreConsole || !consoleSignals.includes(signal)) child.kill(signal)
  }
  handlers.set(signal, handler)
  process.on(signal, handler)
}

function cleanup() {
  for (const [signal, handler] of handlers) process.removeListener(signal, handler)
}

child.on("error", (error) => {
  cleanup()
  console.error(`Amira could not start ${binary}: ${error.message}. Download a binary: ${releases}`)
  process.exitCode = 1
})
child.on("exit", (code, signal) => {
  cleanup()
  if (signal) {
    // Preserve signal termination for shells and parent processes, rather than reporting success.
    process.kill(process.pid, signal)
  } else {
    process.exitCode = code === null ? 1 : code
  }
})
