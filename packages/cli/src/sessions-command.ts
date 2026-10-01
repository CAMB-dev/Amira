import path from "node:path"
import { parseArgs } from "node:util"
import { deleteSession } from "@amira/core"
import { UsageError } from "./args.ts"

export function runSessionsCommand(argv: string[], cwd = process.cwd()): string {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { cwd: { type: "string", short: "C" } },
  })
  if (positionals.length !== 2 || positionals[0] !== "rm")
    throw new UsageError("usage: amira sessions rm <id> [-C <dir>]")
  const id = positionals[1]!
  deleteSession(path.resolve(cwd, values.cwd ?? "."), id)
  return `Deleted session ${id}.\n`
}
