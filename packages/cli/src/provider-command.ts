import { UsageError } from "./args.ts"
import type { PrintIO } from "./print.ts"

export const PROVIDER_USAGE = `Usage:
  amira provider add [<vendor-or-protocol>]
                                       Pick a vendor, then edit its prefilled form
  amira provider add <vendor> (--key-env <VAR> | --key-stdin | --no-key)
      [--id <id>] [--base-url <url>] [--model <id>]...
                                       Add a vendor without questions
  amira provider add <protocol> --id <id> --base-url <url>
      (--key-env <VAR> | --key-stdin | --no-key) [--model <id>]...
                                       Add one without questions
  amira provider edit <id>             Change a provider in a form
  amira provider remove <id> [--yes] [--keep-key]
                                       Remove a provider from settings.json (and its key)
  amira provider key <id>              Store a new API key (masked; or piped on stdin)

Vendors come from the models.dev catalog. Choose Custom for local servers.
Protocols: openai-chat, openai-responses, anthropic-messages, google-gemini.
Protocol names win if they clash with a vendor id. Unmapped vendors need a protocol and URL.
Amira has no built-in providers; only the ones you add exist.`

/** `amira provider help`, and the error for a subcommand provider-cli does not handle. */
export function runProviderCommand(argv: string[], io: PrintIO): number {
  const [sub] = argv
  if (sub === "help" || sub === "--help" || sub === "-h") {
    io.stdout(`${PROVIDER_USAGE}\n`)
    return 0
  }
  const what = sub ? `unknown provider command "${argv.join(" ")}"` : "missing provider command"
  throw new UsageError(`${what}\n\n${PROVIDER_USAGE}`)
}

/**
 * Says how to add a provider after an unknown-provider error: at startup (no session to run
 * /provider in) with `amira provider add`, in a session with /provider add.
 */
export function withProviderHint(message: string, where: "session" | "startup" = "session"): string {
  if (!message.startsWith("unknown provider")) return message
  return where === "startup"
    ? `${message}; add it with amira provider add, or pick another with --model`
    : `${message}; add it with /provider add (or amira provider add)`
}
