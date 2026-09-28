#!/usr/bin/env bun
import type { AnyEvent } from "@amira/api"
import { type Agent, trackWorkspace } from "@amira/core"
import { runInteractive } from "@amira/tui"
import pkg from "../package.json" with { type: "json" }
import { parseCliArgs, USAGE, UsageError } from "./args.ts"
import { runPrint } from "./print.ts"
import { createSession } from "./session.ts"

async function main(argv: string[]): Promise<number> {
  try {
    return await run(argv)
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    process.stderr.write(`amira: ${err.message}\n\nRun amira --help for usage.\n`)
    return 2
  }
}

async function run(argv: string[]): Promise<number> {
  const args = parseCliArgs(argv)
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (args.version) {
    process.stdout.write(`${pkg.version}\n`)
    return 0
  }
  if (!args.model) throw new UsageError("no model selected. Pass --model provider/model or set AMIRA_MODEL.")
  const interactive = !args.print
  if (interactive && !(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new UsageError("the interactive UI needs a terminal; use --print for pipes and scripts")
  }

  // Where failures of event subscribers go: stderr in print mode, the UI in interactive mode.
  let agentRef: Agent | undefined
  const onSubscriberError = (err: unknown, ev: AnyEvent) => {
    const error = `handler for ${ev.type} failed: ${err instanceof Error ? err.message : String(err)}`
    if (interactive && agentRef && ev.type !== "extension.error") {
      agentRef.bus.emit("extension.error", { source: "event subscriber", error }, { sessionId: "host" })
    } else if (!interactive) {
      process.stderr.write(`amira: ${error}\n`)
    }
  }

  const { agent, host, startupEvents } = await createSession({
    model: args.model,
    cwd: args.cwd,
    extensions: args.extensions,
    noBuiltins: args.noBuiltins,
    onSubscriberError,
  })
  agentRef = agent

  // Announce the session once the frontend listens, then fill in git facts in the background.
  let stopWorkspace = () => {}
  const onReady = () => {
    agent.start("startup")
    stopWorkspace = trackWorkspace(agent.bus, agent.sessionId, agent.cwd)
  }
  try {
    if (!interactive) {
      return await runPrint(agent, args.prompt ?? "", args.json, { pending: startupEvents, onReady })
    }
    return await runInteractive({
      agent,
      status: host.status,
      startupEvents,
      onReady,
      ...(args.prompt ? { initialPrompt: args.prompt } : {}),
    })
  } finally {
    stopWorkspace()
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`amira: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  },
)
