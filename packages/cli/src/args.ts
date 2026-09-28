import { statSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"

export interface CliArgs {
  prompt?: string
  print: boolean
  json: boolean
  model?: string
  cwd: string
  extensions: string[]
  noBuiltins: boolean
  help: boolean
  version: boolean
}

export class UsageError extends Error {}

export const USAGE = `Usage: amira [options] [prompt]

Without --print, opens the interactive UI; a prompt becomes the first message.

Options:
  -p, --print           Run one turn non-interactively and print the reply
      --json            With --print, write every event as a JSON line to stdout
  -m, --model <ref>     Model as provider/model (default: $AMIRA_MODEL)
  -e, --extension <f>   Load an extension file (repeatable; relative to where
                        amira is run, not to --cwd)
      --no-builtins     Do not load the built-in tools
  -C, --cwd <dir>       Working directory (default: current directory)
  -h, --help            Show this help
  -v, --version         Show the version

Use -- before a prompt that starts with a dash: amira -p -- "-v means verbose?"

Providers read their API key from the environment, e.g. OPENAI_API_KEY,
DEEPSEEK_API_KEY or OPENROUTER_API_KEY. Ollama and LM Studio need no key.`

export function parseCliArgs(
  argv: string[],
  cwd = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): CliArgs {
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(argv)
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err))
  }
  const { values, positionals } = parsed
  const args: CliArgs = {
    print: values.print ?? false,
    json: values.json ?? false,
    cwd: path.resolve(cwd, values.cwd ?? "."),
    extensions: (values.extension ?? []).map((e) => path.resolve(cwd, e)),
    noBuiltins: values["no-builtins"] ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
  }
  if (positionals.length) args.prompt = positionals.join(" ")
  const model = values.model ?? env.AMIRA_MODEL
  if (model) args.model = model
  if (args.json && !args.print) throw new UsageError("--json requires --print")
  if (args.print && !args.prompt && !args.help && !args.version)
    throw new UsageError("--print needs a prompt")
  if (values.cwd !== undefined && !isDirectory(args.cwd)) {
    throw new UsageError(`--cwd is not a directory: ${args.cwd}`)
  }
  return args
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      print: { type: "boolean", short: "p" },
      json: { type: "boolean" },
      model: { type: "string", short: "m" },
      extension: { type: "string", short: "e", multiple: true },
      "no-builtins": { type: "boolean" },
      cwd: { type: "string", short: "C" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  })
}
