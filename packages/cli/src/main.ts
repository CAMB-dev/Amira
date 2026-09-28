#!/usr/bin/env bun
import pkg from "../package.json" with { type: "json" }
import { parseCliArgs, USAGE, UsageError } from "./args.ts"
import { runPrint } from "./print.ts"
import { createSession } from "./session.ts"

async function main(argv: string[]): Promise<number> {
  let args: ReturnType<typeof parseCliArgs>
  try {
    args = parseCliArgs(argv)
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    process.stderr.write(`amira: ${err.message}\n\n${USAGE}\n`)
    return 2
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (args.version) {
    process.stdout.write(`${pkg.version}\n`)
    return 0
  }
  if (!args.model) {
    process.stderr.write("amira: no model selected. Pass --model provider/model or set AMIRA_MODEL.\n")
    return 2
  }

  const { agent, startupEvents } = await createSession({
    model: args.model,
    cwd: args.cwd,
    extensions: args.extensions,
    noBuiltins: args.noBuiltins,
  })

  if (args.print && args.prompt) return runPrint(agent, args.prompt, args.json, undefined, startupEvents)

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
