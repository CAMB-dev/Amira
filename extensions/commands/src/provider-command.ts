import {
  type CommandCandidate,
  type CommandContext,
  type CommandDefinition,
  DIALECT_NOTES,
  draftFromValues,
  type ProviderAdmin,
  providerFormSpec,
} from "@amira/api"
import { table } from "./format.ts"

const USAGE = "usage: /provider [add [<protocol>] | edit <id> | remove <id> | key <id>]"
const NONE = "No providers configured — add one with /provider add"

const SUBCOMMANDS: Record<string, string> = {
  add: "add a provider: pick its protocol, then fill in a form",
  edit: "change a provider in a form",
  remove: "remove a provider from settings.json",
  key: "store a new API key for a provider",
}

type Ctx = Pick<CommandContext, "session">

function providerIds(ctx: Ctx): CommandCandidate[] {
  return ctx.session.providers().map((p) => ({ value: p.id, description: `${p.dialect} · ${p.baseUrl}` }))
}

function admin(ctx: Ctx): ProviderAdmin {
  const a = ctx.session.providerAdmin
  if (!a) throw new Error("this host cannot change providers")
  return a
}

/** "openai-chat — OpenAI-compatible chat completions (…)", as the protocol picker shows it. */
const protocolLabel = (d: string) => (DIALECT_NOTES[d] ? `${d} — ${DIALECT_NOTES[d]}` : d)

/**
 * /provider: list the configured providers (Amira has none built in), add one (pick a protocol,
 * then fill in a form), edit, remove, and set a key.
 */
export function providerCommand(): CommandDefinition {
  return {
    name: "provider",
    description: "List providers; add, edit or remove one, or set its key",
    args: {
      hint: "[add|edit|remove|key]",
      complete: (prefix, ctx) => {
        const m = /^(\S+)\s+/.exec(prefix)
        const sub = m?.[1]
        if (sub === "add") {
          return (ctx.session.providerAdmin?.dialects() ?? []).map((d) => ({
            value: `add ${d}`,
            description: DIALECT_NOTES[d] ?? "protocol",
          }))
        }
        if (sub === "edit" || sub === "remove" || sub === "key") {
          return providerIds(ctx).map((c) => ({ ...c, value: `${sub} ${c.value}` }))
        }
        return Object.entries(SUBCOMMANDS).map(([value, description]) => ({ value, description }))
      },
    },
    async run(args, ctx) {
      const [sub, id, ...rest] = args.split(/\s+/).filter(Boolean)
      if (!sub) return list(ctx)
      if (rest.length || !Object.hasOwn(SUBCOMMANDS, sub)) throw new Error(USAGE)
      if (sub === "add") return add(ctx, id)
      if (ctx.session.providers().length === 0) throw new Error(NONE)
      if (!id) throw new Error(`usage: /provider ${sub} <id>; providers: ${ids(ctx)}`)
      if (!ctx.session.providers().some((p) => p.id === id))
        throw new Error(`no provider "${id}"; providers: ${ids(ctx)}`)
      if (sub === "edit") return edit(ctx, id)
      if (sub === "remove") return remove(ctx, id)
      return setKey(ctx, id)
    },
  }
}

const ids = (ctx: Ctx) =>
  ctx.session
    .providers()
    .map((p) => p.id)
    .join(", ")

function list(ctx: CommandContext) {
  const current = ctx.session.info().model.provider
  const rows = ctx.session
    .providers()
    .map((p) => [
      p.id === current ? "*" : " ",
      p.id,
      p.dialect,
      p.baseUrl,
      p.hasKey ? "key set" : `no key (${p.apiKeyEnv})`,
    ])
  ctx.print(
    rows.length
      ? `Providers:\n${table(rows)}\nAdd one with /provider add; change one with /provider edit <id>.`
      : NONE,
  )
}

/** Picks the protocol (unless given), then opens the provider form with it preselected. */
async function add(ctx: CommandContext, protocol: string | undefined) {
  const a = admin(ctx)
  const dialects = a.dialects()
  let dialect = protocol
  if (dialect !== undefined && !dialects.includes(dialect)) {
    throw new Error(`unknown protocol "${dialect}"; protocols: ${dialects.join(", ")}`)
  }
  if (dialect === undefined) {
    const labels = dialects.map(protocolLabel)
    const picked = await ctx.ui.select("Which protocol does the provider speak?", labels, {
      signal: ctx.signal,
    })
    if (picked === undefined) {
      ctx.print("Cancelled; nothing was saved.")
      return
    }
    dialect = dialects[labels.indexOf(picked)]
    if (dialect === undefined) throw new Error(`${USAGE}; protocols: ${dialects.join(", ")}`)
  }
  const values = await ctx.ui.form(providerFormSpec(a, undefined, { dialect }), { signal: ctx.signal })
  if (!values) {
    ctx.print("Cancelled; nothing was saved.")
    return
  }
  ctx.print(await a.save(draftFromValues(values)))
}

async function edit(ctx: CommandContext, id: string) {
  const a = admin(ctx)
  const existing = a.draft(id)
  if (!existing) throw new Error(`no provider "${id}"`)
  const values = await ctx.ui.form(providerFormSpec(a, existing), { signal: ctx.signal })
  if (!values) {
    ctx.print("Cancelled; nothing was changed.")
    return
  }
  ctx.print(await a.save(draftFromValues(values, id)))
}

async function remove(ctx: CommandContext, id: string) {
  const a = admin(ctx)
  if (ctx.session.info().model.provider === id) {
    throw new Error(`provider "${id}" is in use; switch to another model with /model first`)
  }
  const ok = await ctx.ui.confirm(`Remove provider ${id}?`, "Its entry is deleted from your settings.json.", {
    signal: ctx.signal,
  })
  if (!ok) {
    ctx.print("Kept it.")
    return
  }
  const stored = a.storedKeyHint(id)
  const removeKey = stored
    ? (await ctx.ui.confirm(`Also delete its key (${stored}) from ~/.amira/auth.json?`, undefined, {
        signal: ctx.signal,
      })) === true
    : false
  ctx.print(await a.remove(id, { removeKey }))
}

async function setKey(ctx: CommandContext, id: string) {
  const a = admin(ctx)
  const stored = a.storedKeyHint(id)
  const key = await ctx.ui.input(`API key for ${id}${stored ? ` (replaces ${stored})` : ""}`, {
    secret: true,
    placeholder: "paste the key",
    signal: ctx.signal,
  })
  if (!key?.trim()) {
    ctx.print("No key given; nothing changed.")
    return
  }
  ctx.print(await a.setKey(id, key))
}
