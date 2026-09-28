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
  /** Resume the most recent session in cwd. */
  continue: boolean
  /** Resume this session id; "" means list the sessions to pick from. */
  resume?: string
  /** Which shell tools the model gets on Windows (D68). Unset: from settings. */
  shell?: ShellMode
  /** Tools hidden from the model (D70). Unset: from settings. */
  disabledTools?: string[]
  help: boolean
  version: boolean
  /** Headless JSONL protocol on stdin and stdout. */
  rpc: boolean
  /** Print the JSON Schema of the rpc protocol and exit. */
  rpcSchema: boolean
}

export type ShellMode = "auto" | "bash" | "powershell"

export class UsageError extends Error {}

export const USAGE = `Usage: amira [options] [prompt]

Without --print, opens the interactive UI; a prompt becomes the first message.

Options:
  -p, --print           Run one turn non-interactively and print the reply
      --json            With --print, write every event as a JSON line to stdout
      --rpc             Headless mode: JSONL commands on stdin, responses and
                        events on stdout (see --rpc-schema)
      --rpc-schema      Print the JSON Schema of the --rpc protocol
  -m, --model <ref>     Model as provider/model (default: $AMIRA_MODEL, then
                        "model" in settings.json)
  -e, --extension <f>   Load an extension file (repeatable; relative to where
                        amira is run, not to --cwd)
      --no-builtins     Do not load the built-in tools
  -c, --continue        Resume the most recent session in this directory
  -r, --resume [id]     Resume a session; without an id, list them to pick one
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

Sub-agents run in the background, and their results start a turn of their own.
--print (and --rpc once stdin closes) waits for the ones still running and the
turns their results start before exiting, however long they take (the budget
in settings.json limits them), including up to three resends 10, 30 and 90 s
after a turn with their results fails; Ctrl+C stops waiting. Sub-agents still running
at exit are stopped and given up to 5 s to wrap up.

Commands:
  amira provider presets [id]   Print settings.json entries for known providers
  amira provider add <id>       Add a preset to ~/.amira/settings.json
  amira ext <command>           Install, list, update, remove and search extension
                                packages (see amira ext help)
  amira <name> ...              A command an installed package provides

Settings come from ~/.amira/settings.json, <cwd>/.amira/settings.json and
<cwd>/.amira/settings.local.json (later files win; flags win over all). Provider
baseUrl, apiKeyEnv and headers are only read from ~/.amira/settings.json.

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
    parsed = parse(optionalResumeValue(argv))
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
    continue: values.continue ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
    rpc: values.rpc ?? false,
    rpcSchema: values["rpc-schema"] ?? false,
  }
  if (positionals.length) args.prompt = positionals.join(" ")
  if (values.resume !== undefined) args.resume = values.resume
  if (args.continue && args.resume !== undefined) throw new UsageError("use either --continue or --resume")
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
  if (args.rpc && (args.print || args.prompt !== undefined)) {
    throw new UsageError("--rpc takes prompts on stdin; it cannot be combined with --print or a prompt")
  }
  if (args.rpc && args.resume === "") {
    throw new UsageError("--rpc cannot pick a session; pass --resume <id>, or send session.resume")
  }
  if (args.json && !args.print) throw new UsageError("--json requires --print")
  const listing = args.resume === ""
  if (args.print && !args.prompt && !args.help && !args.version && !listing)
    throw new UsageError("--print needs a prompt")
  if (args.print && listing && args.prompt)
    throw new UsageError(
      "with --print, --resume without a session id only lists sessions; pass an id to send a prompt",
    )
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

/**
 * --resume takes an optional id: a bare flag becomes `--resume=` so parseArgs sees an empty
 * value. A group of boolean short flags ending in r, like -pr, is split first.
 */
function optionalResumeValue(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i]!
    if (a === "--") {
      out.push(...argv.slice(i))
      break
    }
    if (FLAGS_THEN_R.test(a)) {
      out.push(a.slice(0, -1))
      a = "-r"
    }
    const next = argv[i + 1]
    if ((a === "-r" || a === "--resume") && (next === undefined || !SESSION_ID.test(next)))
      out.push("--resume=")
    else out.push(a)
  }
  return out
}

const SESSION_ID = /^s_[\w-]+$/
const FLAGS_THEN_R = /^-[pchv]+r$/

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
      continue: { type: "boolean", short: "c" },
      resume: { type: "string", short: "r" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      rpc: { type: "boolean" },
      "rpc-schema": { type: "boolean" },
    },
  })
}
