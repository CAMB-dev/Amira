#!/usr/bin/env bun
// The hidden `amira server` entry (daemon, relay, list) is dispatched before any TUI, settings or
// extension module loads, and the TUI cold start never evaluates the server graph: both are dynamic imports.
const argv = process.argv.slice(2)
if (argv[0] === "server") {
  const { serverMain } = await import("./server-main.ts")
  // A daemon relaunches this same executable (or this script under Bun) with the server subcommand.
  process.exitCode = await serverMain(argv.slice(1), { script: import.meta.path, subcommand: ["server"] })
} else await import("./cli-main.ts")

export {}
