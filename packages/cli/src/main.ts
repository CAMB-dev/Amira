#!/usr/bin/env bun
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

  const { agent, startupEvents } = await createSession({
    model: args.model,
    cwd: args.cwd,
    extensions: args.extensions,
    noBuiltins: args.noBuiltins,
    onSubscriberError: (err, ev) =>
      process.stderr.write(
        `amira: an event handler failed on ${ev.type}: ${err instanceof Error ? err.message : String(err)}\n`,
      ),
  })

  if (args.print && args.prompt) return runPrint(agent, args.prompt, args.json, { pending: startupEvents })

  process.stderr.write("amira: the interactive UI is not available yet; use --print.\n")
  return 2
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`amira: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  },
)
