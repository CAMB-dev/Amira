import {
  type CommandCandidate,
  type CommandContext,
  type CommandDefinition,
  DIALECT_NOTES,
  draftFromValues,
  type ProviderAdmin,
  type ProviderFormInitial,
  providerFormSpec,
  providerVendorInitial,
  providerVendorLabel,
} from "@amira/api"
import { table } from "./format.ts"

const USAGE = "usage: /provider [add [<vendor|protocol>] | edit <id> | remove <id> | key <id>]"
const CUSTOM = "Custom (choose a protocol)"
const CATALOG_UNAVAILABLE = "Provider catalog unavailable; choose a protocol to add a custom provider."
const NONE = "No providers configured — add one with /provider add"

const SUBCOMMANDS: Record<string, string> = {
  add: "add a provider: pick a vendor or Custom, then fill in a form",
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
 * /provider: list configured providers, add one from a catalog vendor or a custom protocol,
 * edit, remove, and set a key.
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
          // Completion is synchronous: vendors are loaded only when add runs.
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

/** Picks a vendor unless a protocol is given; Custom keeps the protocol-first flow. */
async function add(ctx: CommandContext, choice: string | undefined) {
  const a = admin(ctx)
  const dialects = a.dialects()
  let initial: ProviderFormInitial = {}
  let custom = true
  if (choice !== undefined && dialects.includes(choice)) {
    initial.dialect = choice
  } else {
    const vendors =
      (await a.vendors?.({
        onLoading: () => ctx.print("Loading vendors from models.dev…"),
      })) ?? []
    if (choice !== undefined) {
      if (!vendors.length) {
        throw new Error(
          `Vendor catalog unavailable (offline?); cannot look up "${choice}". Choose a protocol instead: ${dialects.join(", ")}`,
        )
      }
      const vendor = vendors.find((v) => v.id === choice)
      if (!vendor) {
        throw new Error(`unknown vendor or protocol "${choice}"; protocols: ${dialects.join(", ")}`)
      }
      initial = providerVendorInitial(a, vendor)
      custom = false
    } else if (vendors.length) {
      const labels = vendors.map(providerVendorLabel)
      const picked = await ctx.ui.select("Which provider do you want to add?", [...labels, CUSTOM], {
        signal: ctx.signal,
      })
      if (picked === undefined) {
        ctx.print("Cancelled; nothing was saved.")
        return
      }
      if (picked !== CUSTOM) {
        const vendor = vendors[labels.indexOf(picked)]
        if (!vendor) throw new Error(USAGE)
        initial = providerVendorInitial(a, vendor)
        custom = false
      }
    } else {
      ctx.print(CATALOG_UNAVAILABLE)
    }
  }
  if (custom && initial.dialect === undefined) {
    const labels = dialects.map(protocolLabel)
    const picked = await ctx.ui.select("Which protocol does the provider speak?", labels, {
      signal: ctx.signal,
    })
    if (picked === undefined) {
      ctx.print("Cancelled; nothing was saved.")
      return
    }
    initial.dialect = dialects[labels.indexOf(picked)]
    if (initial.dialect === undefined) throw new Error(`${USAGE}; protocols: ${dialects.join(", ")}`)
  }
  const values = await ctx.ui.form(providerFormSpec(a, undefined, initial), { signal: ctx.signal })
  if (!values) {
    ctx.print("Cancelled; nothing was saved.")
    return
  }
  ctx.print(await a.save(draftFromValues(values, undefined, initial.catalogId)))
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
  ctx.print(await a.save(draftFromValues(values, id, existing.catalogId)))
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
