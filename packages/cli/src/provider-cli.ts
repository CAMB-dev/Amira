import path from "node:path"
import { createInterface } from "node:readline"
import { createAi } from "@amira/ai"
import {
  type FormDialogs,
  type FormSpec,
  type FormValues,
  type ProviderAdmin,
  type ProviderDraft,
  runFormDialogs,
} from "@amira/api"
import { amiraHome, authFile, loadAuth, loadSettings, providersFromSettings } from "@amira/core"
import { draftFromValues, type ProviderFormInitial, providerFormSpec } from "@amira/ext-commands"
import { runFormScreen } from "@amira/tui"
import { UsageError } from "./args.ts"
import { readCatalogCache } from "./catalog.ts"
import type { PrintIO } from "./print.ts"
import { createProviderAdmin } from "./provider-admin.ts"
import { PROVIDER_USAGE as USAGE } from "./provider-command.ts"

/** Reads one answer from the user; undefined at the end of input. */
export type ReadLine = (prompt: string) => Promise<string | undefined>

export interface ProviderCliOptions {
  io: PrintIO
  home?: string
  cwd?: string
  env?: Record<string, string | undefined>
  /** stdin and stdout are a terminal: forms show full screen. Default: they are. */
  interactive?: boolean
  /** Shows a form full screen; injectable for tests. */
  runForm?: (spec: FormSpec) => Promise<FormValues | undefined>
  /** Reads answers when there is no terminal (piped stdin); injectable for tests. */
  readLine?: ReadLine
  /** Replaces the admin built from the settings; for tests. */
  admin?: ProviderAdmin
}

/** The flags of `amira provider add`; with all of them no question is asked. */
interface AddFlags {
  id?: string
  baseUrl?: string
  keyEnv?: string
  keyStdin: boolean
  noKey: boolean
  models: string[]
}

const VALUE_FLAGS: Record<string, "id" | "baseUrl" | "keyEnv" | "model"> = {
  "--id": "id",
  "--base-url": "baseUrl",
  "--key-env": "keyEnv",
  "--model": "model",
}

/** Splits `add` arguments into the protocol and the flags (`--flag value` or `--flag=value`). */
function parseAdd(args: string[]): { protocol?: string; flags: AddFlags } {
  const flags: AddFlags = { keyStdin: false, noKey: false, models: [] }
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf("=")
    const name = eq > 0 ? arg.slice(0, eq) : arg
    if (name === "--key-stdin" || name === "--no-key") {
      if (eq > 0) throw new UsageError(`${name} takes no value\n\n${USAGE}`)
      if (name === "--key-stdin") flags.keyStdin = true
      else flags.noKey = true
      continue
    }
    const key = Object.hasOwn(VALUE_FLAGS, name) ? VALUE_FLAGS[name] : undefined
    if (!key) throw new UsageError(`unexpected "${arg}"\n\n${USAGE}`)
    const value = eq > 0 ? arg.slice(eq + 1) : args[++i]
    if (value === undefined || value === "" || (eq < 0 && value.startsWith("--")))
      throw new UsageError(`${name} needs a value\n\n${USAGE}`)
    if (key === "model") {
      if (!flags.models.includes(value)) flags.models.push(value)
    } else if (flags[key] !== undefined) throw new UsageError(`${name} is given twice\n\n${USAGE}`)
    else flags[key] = value
  }
  if (positional.length > 1) throw new UsageError(`unexpected "${positional.slice(1).join(" ")}"\n\n${USAGE}`)
  const keys = [flags.keyEnv !== undefined, flags.keyStdin, flags.noKey].filter(Boolean).length
  if (keys > 1) throw new UsageError(`pass one of --key-env, --key-stdin and --no-key\n\n${USAGE}`)
  return { ...(positional[0] ? { protocol: positional[0] } : {}), flags }
}

/** A draft when the flags say everything; undefined when the form has to ask the rest. */
function draftFromFlags(
  protocol: string | undefined,
  f: AddFlags,
): Omit<ProviderDraft, "apiKey"> | undefined {
  const keyGiven = f.keyEnv !== undefined || f.keyStdin || f.noKey
  if (!protocol || !f.id || !f.baseUrl || !keyGiven) return undefined
  return {
    id: f.id,
    dialect: protocol,
    baseUrl: f.baseUrl.trim().replace(/\/+$/, ""),
    keySource: f.keyEnv !== undefined ? "env" : f.keyStdin ? "auth" : "none",
    ...(f.keyEnv !== undefined ? { apiKeyEnv: f.keyEnv } : {}),
    models: f.models,
    defaults: {},
  }
}

/** What the form starts with when the flags leave something out. */
function formInitial(protocol: string | undefined, f: AddFlags): ProviderFormInitial {
  return {
    ...(protocol ? { dialect: protocol } : {}),
    ...(f.id ? { id: f.id } : {}),
    ...(f.baseUrl ? { baseUrl: f.baseUrl } : {}),
    ...(f.keyEnv !== undefined ? { keySource: "env" as const, apiKeyEnv: f.keyEnv } : {}),
    ...(f.noKey ? { keySource: "none" as const } : {}),
    ...(f.models.length ? { models: f.models } : {}),
  }
}

/**
 * `amira provider add | edit | remove | key`, the same as /provider in a session: forms show
 * full screen on a terminal and are asked line by line from piped stdin. `add` with the
 * protocol, --id, --base-url and a key flag asks nothing. Undefined for other subcommands.
 */
export async function runProviderAdminCommand(
  argv: string[],
  opts: ProviderCliOptions,
): Promise<number | undefined> {
  const [sub, id, ...rest] = argv
  if (sub !== "add" && sub !== "edit" && sub !== "remove" && sub !== "key") return undefined
  const added = sub === "add" ? parseAdd(argv.slice(1)) : undefined
  const flags = new Set(rest.filter((a) => a.startsWith("--")))
  if (!added) {
    const extra = rest.filter((a) => !a.startsWith("--"))
    if (!id || id.startsWith("--")) throw new UsageError(`missing provider id\n\n${USAGE}`)
    const allowed = sub === "remove" ? ["--yes", "--keep-key"] : []
    const unknown = [...flags].filter((f) => !allowed.includes(f))
    if (extra.length || unknown.length)
      throw new UsageError(`unexpected "${[...extra, ...unknown].join(" ")}"\n\n${USAGE}`)
  }
  const complete = added ? draftFromFlags(added.protocol, added.flags) : undefined
  if (added?.flags.keyStdin && !complete) {
    throw new UsageError(`--key-stdin needs the protocol, --id and --base-url too\n\n${USAGE}`)
  }

  const { io } = opts
  const interactive = opts.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const lines = opts.readLine ? undefined : stdinLines(io)
  const readLine = opts.readLine ?? lines!.read
  const ask = (spec: FormSpec) =>
    interactive
      ? (opts.runForm ?? ((s) => runFormScreen(s)))(spec)
      : runFormDialogs(spec, lineDialogs(io, readLine))
  try {
    const home = opts.home ?? amiraHome()
    const { admin, model } = opts.admin
      ? { admin: opts.admin, model: undefined }
      : await adminFor(home, opts.cwd ?? process.cwd(), opts.env ?? process.env)
    if (added) {
      const protocols = admin.dialects()
      if (added.protocol && !protocols.includes(added.protocol)) {
        throw new UsageError(`unknown protocol "${added.protocol}"; protocols: ${protocols.join(", ")}`)
      }
      if (complete) {
        if (admin.exists(complete.id)) {
          throw new UsageError(
            `provider "${complete.id}" exists already; change it with amira provider edit ${complete.id}`,
          )
        }
        let apiKey: string | undefined
        if (added.flags.keyStdin) {
          // Typed at a terminal the key would show; the masked form is for that.
          if (!opts.readLine && process.stdin.isTTY) {
            throw new UsageError("--key-stdin reads a piped key; to type it masked, leave out the key flags")
          }
          apiKey = (await readLine(""))?.trim()
          if (!apiKey) throw new UsageError("--key-stdin: no key on stdin")
        }
        io.stdout(`${await admin.save({ ...complete, ...(apiKey ? { apiKey } : {}) })}\n`)
        return 0
      }
      const values = await ask(providerFormSpec(admin, undefined, formInitial(added.protocol, added.flags)))
      if (!values) return cancelled(io)
      io.stdout(`${await admin.save(draftFromValues(values))}\n`)
      return 0
    }
    const pid = id!
    if (!admin.exists(pid)) throw new UsageError(`no provider "${pid}"`)
    if (sub === "edit") {
      const existing = admin.draft(pid)!
      const values = await ask(providerFormSpec(admin, existing))
      if (!values) return cancelled(io)
      io.stdout(`${await admin.save(draftFromValues(values, pid))}\n`)
      return 0
    }
    if (sub === "remove") {
      const dialogs = lineDialogs(io, readLine)
      if (!flags.has("--yes")) {
        const ok = await dialogs.select(`Remove provider ${pid} from settings.json?`, ["No", "Yes"])
        if (ok !== "Yes") return cancelled(io)
      }
      const stored = admin.storedKeyHint(pid)
      let removeKey = Boolean(stored) && !flags.has("--keep-key")
      if (stored && !flags.has("--yes") && !flags.has("--keep-key")) {
        removeKey =
          (await dialogs.select(`Also delete its key (${stored}) from auth.json?`, ["No", "Yes"])) === "Yes"
      }
      io.stdout(`${await admin.remove(pid, { removeKey })}\n`)
      if (model?.startsWith(`${pid}/`)) {
        io.stderr(`amira: warning: "model" in settings.json (${model}) uses this provider; change it too.\n`)
      }
      return 0
    }
    const key = interactive
      ? ((
          await ask({
            title: `API key for ${pid}`,
            description: "Stored in ~/.amira/auth.json, which only you can read.",
            fields: [
              {
                type: "secret",
                id: "apiKey",
                label: "API key",
                required: true,
                placeholder: "paste the key",
              },
            ],
          })
        )?.apiKey as string | undefined)
      : await readLine("")
    if (!key?.trim()) return cancelled(io)
    io.stdout(`${await admin.setKey(pid, key.trim())}\n`)
    return 0
  } catch (err) {
    if (err instanceof UsageError) throw err
    io.stderr(`amira: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  } finally {
    lines?.close()
  }
}

function cancelled(io: PrintIO): number {
  io.stderr("Cancelled; nothing was changed.\n")
  return 1
}

/** The providers of the settings and auth.json, with the cached catalog, as a session would have them. */
async function adminFor(
  home: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<{ admin: ProviderAdmin; model?: string }> {
  const { settings } = loadSettings({ cwd, home })
  const { keys } = loadAuth(authFile(home))
  const { catalog } = await readCatalogCache({ file: path.join(home, "cache", "models.json") })
  const ai = createAi({
    providers: providersFromSettings(settings.providers),
    apiKeys: keys,
    env,
    ...(catalog ? { catalog } : {}),
  })
  // Outside a session no model is in use; the configured one's provider is only warned about.
  const admin = createProviderAdmin({ ai, home, env })
  return { admin, ...(settings.model ? { model: settings.model } : {}) }
}

/** Select and input dialogs as numbered prompts on stderr, answered line by line. */
export function lineDialogs(io: PrintIO, readLine: ReadLine): FormDialogs {
  return {
    async select(title, options) {
      io.stderr(`\n${title}\n${options.map((o, i) => `  ${i + 1}) ${o}`).join("\n")}\n`)
      for (;;) {
        const a = await readLine(`Choose 1-${options.length} [1]: `)
        if (a === undefined) return undefined
        const t = a.trim()
        if (!t) return options[0]
        const n = Number(t)
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]
        const exact = options.find((o) => o === t)
        if (exact) return exact
        io.stderr(`  Type a number from 1 to ${options.length}.\n`)
      }
    },
    async input(title, o) {
      const hint = o?.initial ? ` [${o.initial}]` : o?.placeholder ? ` (${o.placeholder})` : ""
      io.stderr(`\n${title}${hint}\n`)
      // Line mode cannot mask; say so rather than echo a key unannounced.
      if (o?.secret && process.stdin.isTTY)
        io.stderr("(what you type is shown; use a terminal for the masked form)\n")
      const a = await readLine("> ")
      if (a === undefined) return undefined
      return a === "" && o?.initial ? o.initial : a
    },
  }
}

/** Lines from stdin; prompts go to stderr so stdout keeps only results. */
function stdinLines(io: PrintIO): { read: ReadLine; close: () => void } {
  let rl: ReturnType<typeof createInterface> | undefined
  let it: AsyncIterator<string> | undefined
  return {
    read: async (prompt) => {
      rl ??= createInterface({ input: process.stdin, terminal: false })
      it ??= rl[Symbol.asyncIterator]()
      if (prompt) io.stderr(prompt)
      const r = await it.next()
      return r.done ? undefined : r.value
    },
    close: () => rl?.close(),
  }
}
