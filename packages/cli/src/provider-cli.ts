import path from "node:path"
import { createInterface } from "node:readline"
import { createAi } from "@amira/ai"
import {
  type FormDialogs,
  type FormSpec,
  type FormValues,
  type ProviderAdmin,
  runFormDialogs,
} from "@amira/api"
import { amiraHome, authFile, loadAuth, loadSettings, providersFromSettings } from "@amira/core"
import { draftFromValues, providerFormSpec } from "@amira/ext-commands"
import { runFormScreen } from "@amira/tui"
import { UsageError } from "./args.ts"
import { readCatalogCache } from "./catalog.ts"
import type { PrintIO } from "./print.ts"
import { createProviderAdmin } from "./provider-admin.ts"

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

const USAGE = `Usage:
  amira provider add custom            Add any provider in a form (fetch models, test it)
  amira provider edit <id>             Change a provider in a form
  amira provider remove <id> [--yes] [--keep-key]
                                       Remove a provider from settings.json (and its key)
  amira provider key <id>              Store a new API key (masked; or piped on stdin)`

/**
 * `amira provider add custom | edit | remove | key`, the same as /provider in a session: forms
 * show full screen on a terminal and are asked line by line from piped stdin. Undefined for
 * the subcommands this does not handle (presets, add <preset>).
 */
export async function runProviderAdminCommand(
  argv: string[],
  opts: ProviderCliOptions,
): Promise<number | undefined> {
  const [sub, id, ...rest] = argv
  const flags = new Set(rest.filter((a) => a.startsWith("--")))
  const extra = rest.filter((a) => !a.startsWith("--"))
  if (sub === "add" && id !== "custom") return undefined
  if (sub !== "add" && sub !== "edit" && sub !== "remove" && sub !== "key") return undefined
  if (sub !== "add" && !id) throw new UsageError(`missing provider id\n\n${USAGE}`)
  const allowed = sub === "remove" ? ["--yes", "--keep-key"] : []
  const unknown = [...flags].filter((f) => !allowed.includes(f))
  if (extra.length || unknown.length)
    throw new UsageError(`unexpected "${[...extra, ...unknown].join(" ")}"\n\n${USAGE}`)

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
    if (sub === "add") {
      const values = await ask(providerFormSpec(admin))
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
