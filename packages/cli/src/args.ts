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
  /** Which shell tools the model gets on Windows (D68). Unset: from settings. */
  shell?: ShellMode
  /** Tools hidden from the model (D70). Unset: from settings. */
  disabledTools?: string[]
  help: boolean
  version: boolean
}

export type ShellMode = "auto" | "bash" | "powershell"

export class UsageError extends Error {}

export const USAGE = `Usage: amira [options] [prompt]

Without --print, opens the interactive UI; a prompt becomes the first message.

Options:
  -p, --print           Run one turn non-interactively and print the reply
      --json            With --print, write every event as a JSON line to stdout
  -m, --model <ref>     Model as provider/model (default: $AMIRA_MODEL, then
                        "model" in settings.json)
  -e, --extension <f>   Load an extension file (repeatable; relative to where
                        amira is run, not to --cwd)
      --no-builtins     Do not load the built-in tools
      --shell <mode>    Shell tools on Windows: auto (bash and powershell, the
                        model picks), bash or powershell (default: "shell"
                        in settings.json, else auto)
      --disable-tools <names>
                        Hide tools from the model, comma-separated (repeatable;
                        replaces "tools.disabled" from settings.json)
  -C, --cwd <dir>       Working directory (default: current directory)
  -h, --help            Show this help
  -v, --version         Show the version

Use -- before a prompt that starts with a dash: amira -p -- "-v means verbose?"

Commands:
  amira provider presets [id]   Print settings.json entries for known providers
  amira provider add <id>       Add a preset to ~/.amira/settings.json

Settings come from ~/.amira/settings.json, <cwd>/.amira/settings.json and
<cwd>/.amira/settings.local.json (later files win; flags win over all).

Built-in providers: anthropic, openai, openai-chat and google. Others, such as
deepseek, openrouter, ollama or lmstudio, are added with amira provider add.
API keys come from the environment (ANTHROPIC_API_KEY, OPENAI_API_KEY,
GEMINI_API_KEY, ...) or from ~/.amira/auth.json: {"<provider>": {"apiKey": "..."}}.
$AMIRA_HOME replaces ~/.amira.`

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
  if (values.shell !== undefined) args.shell = parseShell(values.shell)
  if (values["disable-tools"]) {
    args.disabledTools = values["disable-tools"].flatMap((v) =>
      v
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    )
  }
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

function parseShell(value: string | undefined): ShellMode {
  if (value === undefined || value === "auto") return "auto"
  if (value === "bash" || value === "powershell") return value
  throw new UsageError(`--shell must be auto, bash or powershell, got "${value}"`)
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
      shell: { type: "string" },
      "disable-tools": { type: "string", multiple: true },
      cwd: { type: "string", short: "C" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  })
}
