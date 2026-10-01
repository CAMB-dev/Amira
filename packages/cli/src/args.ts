import { statSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import type { PermissionMode } from "@amira/api"

export interface CliArgs {
  prompt?: string
  print: boolean
  json: boolean
  model?: string
  cwd: string
  extensions: string[]
  noBuiltins: boolean
  /** Load no extension packages this run (--no-packages). */
  noPackages: boolean
  /** Resume the most recent session in cwd. */
  continue: boolean
  /** Resume this session id; "" means list the sessions to pick from. */
  resume?: string
  /** Which shell tools the model gets on Windows (D68). Unset: from settings. */
  shell?: ShellMode
  /** Tools hidden from the model (D70). Unset: from settings. */
  disabledTools?: string[]
  /** The permission mode to start in (--permission-mode). Unset: from settings, else auto. */
  permissionMode?: PermissionMode
  help: boolean
  version: boolean
  /** How the interactive UI draws: --fullscreen or --inline. Unset: from settings, else full screen. */
  mode?: "fullscreen" | "inline"
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
                        "model" in settings.json, then the first model of the
                        only configured provider)
  -e, --extension <f>   Load an extension file (repeatable; relative to where
                        amira is run, not to --cwd)
      --no-builtins     Do not load the built-in tools
      --no-packages     Do not load installed extension packages (for this run)
  -c, --continue        Resume the most recent session in this directory
  -r, --resume [id]     Resume a session; without an id, list them to pick one
      --shell <mode>    Shell tools on Windows: auto (bash and powershell, the
                        model picks), bash or powershell (default: "shell"
                        in settings.json, else auto)
      --disable-tools <names>
                        Hide tools from the model, comma-separated (repeatable;
                        replaces "tools.disabled" from settings.json)
      --permission-mode <mode>
                        What the model may do without asking: auto (default;
                        asks only where rules and protected files say), edits
                        (changes files, asks before shell commands) or plan
                        (read-only: no file changes, no shell commands). Wins
                        over "permissions.mode" in settings.json; Shift+Tab
                        cycles it in the UI
      --fullscreen      Draw the UI full screen: Amira scrolls, searches and
                        folds the conversation, and prints it on exit (default,
                        or "tui.mode" in settings.json)
      --inline          Draw the UI inline: finished output goes to the
                        terminal's scrollback (for SSH, tmux, native selection)
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
  amira provider <command>      Add, edit and remove providers and their keys
                                (see amira provider help)
  amira ext <command>           Install, list, update, remove and search extension
                                packages (see amira ext help)
  amira <name> ...              A command an installed package provides

Settings come from ~/.amira/settings.json, <cwd>/.amira/settings.json and
<cwd>/.amira/settings.local.json (later files win; flags win over all). Provider
baseUrl, apiKeyEnv and headers are only read from ~/.amira/settings.json.

Amira has no built-in providers: add each one with amira provider add (or
/provider add in a session), picking the protocol it speaks (openai-chat,
openai-responses, anthropic-messages or google-gemini), its base URL and models.
API keys come from the environment variable a provider names (apiKeyEnv) or from
~/.amira/auth.json: {"<provider>": {"apiKey": "..."}}.
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
    noPackages: values["no-packages"] ?? false,
    continue: values.continue ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
    rpc: values.rpc ?? false,
    rpcSchema: values["rpc-schema"] ?? false,
  }
  if (positionals.length) args.prompt = positionals.join(" ")
  if (values.resume !== undefined) args.resume = values.resume
  if (args.continue && args.resume !== undefined) throw new UsageError("use either --continue or --resume")
  if (values.inline && values.fullscreen) throw new UsageError("use either --inline or --fullscreen")
  if (values.inline) args.mode = "inline"
  if (values.fullscreen) args.mode = "fullscreen"
  if (values.shell !== undefined) args.shell = parseShell(values.shell)
  if (values["permission-mode"] !== undefined) {
    const mode = values["permission-mode"]
    if (mode !== "auto" && mode !== "edits" && mode !== "plan") {
      throw new UsageError(`--permission-mode must be auto, edits or plan, got "${mode}"`)
    }
    args.permissionMode = mode
  }
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
      "no-packages": { type: "boolean" },
      shell: { type: "string" },
      "disable-tools": { type: "string", multiple: true },
      "permission-mode": { type: "string" },
      cwd: { type: "string", short: "C" },
      continue: { type: "boolean", short: "c" },
      resume: { type: "string", short: "r" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      inline: { type: "boolean" },
      fullscreen: { type: "boolean" },
      rpc: { type: "boolean" },
      "rpc-schema": { type: "boolean" },
    },
  })
}
