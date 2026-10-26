import {
  type CommandCandidate,
  type CommandContext,
  type CommandDefinition,
  DIALECT_NOTES,
  draftFromValues,
  modelLabel,
  type ProviderAdmin,
  type ProviderFormInitial,
  providerFormSpec,
  providerVendorInitial,
} from "@amira/api"
import { table } from "./format.ts"
import { pickModel } from "./model-command.ts"
import { ProviderConnectionTests } from "./provider-tests.ts"

const USAGE = "usage: /provider [add [<vendor|protocol>] | edit <id> | remove <id> | key <id>]"
const ADD = "+ Add provider"
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

/**
 * /provider: list configured providers, add one from a catalog vendor or a custom protocol,
 * edit, remove, and set a key.
 */
export function providerCommand(): CommandDefinition {
  const tests = new ProviderConnectionTests()
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
      if (!sub) return ctx.frontend === "tui" ? manage(ctx, tests) : list(ctx)
      if (rest.length || !Object.hasOwn(SUBCOMMANDS, sub)) throw new Error(USAGE)
      const tracked = () => tests.wrap(ctx.session.info().id, admin(ctx))
      if (sub === "add") {
        const saved = await add(ctx, id, tracked())
        if (saved && ctx.frontend === "tui") await manage(ctx, tests, saved)
        return
      }
      if (ctx.session.providers().length === 0) throw new Error(NONE)
      if (!id) throw new Error(`usage: /provider ${sub} <id>; providers: ${ids(ctx)}`)
      if (!ctx.session.providers().some((p) => p.id === id))
        throw new Error(`no provider "${id}"; providers: ${ids(ctx)}`)
      if (sub === "edit") {
        const saved = await edit(ctx, id, tracked())
        if (saved && ctx.frontend === "tui") await manage(ctx, tests, saved)
        return
      }
      if (sub === "remove") return remove(ctx, id, tracked())
      return setKey(ctx, id, tracked())
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

/** The management page is TUI-only; print and RPC keep the original table. */
async function manage(
  ctx: CommandContext,
  tests: ProviderConnectionTests,
  highlight?: string,
): Promise<void> {
  const sessionId = ctx.session.info().id
  const a = tests.wrap(sessionId, admin(ctx))
  const providers = ctx.session.providers()
  // Like /model: open on the provider in use and mark it current.
  const current = ctx.session.info().model.provider
  const initial = highlight ?? (providers.some((p) => p.id === current) ? current : undefined)
  const descriptions = providers.map((p) => {
    const draft = a.draft(p.id)
    const url = p.baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")
    const shortUrl = url.length > 42 ? `${url.slice(0, 41)}…` : url || "(no URL)"
    const count = draft?.models.length ?? 0
    const source = draft?.keySource ?? (p.apiKeyEnv ? "env" : "none")
    const variable = draft?.apiKeyEnv ?? p.apiKeyEnv
    const key =
      source === "env" ? (variable ? `env (${variable})` : "env") : source === "auth" ? "auth.json" : "none"
    const status = tests.status(sessionId, a, p.id)
    return `${p.id === current ? "current · " : ""}${p.dialect} · ${shortUrl} · ${count} ${count === 1 ? "model" : "models"} · key: ${key}${status ? ` · ${status}` : ""}`
  })
  const picked = await ctx.ui.choose("Providers", [ADD, ...providers.map((p) => p.id)], {
    sections: [
      { at: 0, choose: "add" },
      ...(providers.length ? [{ at: 1, title: "Configured", choose: "manage" }] : []),
    ],
    descriptions: ["Configure a provider and its models", ...descriptions],
    ...(initial ? { initial } : {}),
    signal: ctx.signal,
  })
  if (!picked) return
  if (picked.option === ADD) {
    const saved = await add(ctx, undefined, a)
    if (saved) await manage(ctx, tests, saved)
    return
  }
  const id = picked.option
  const action = await ctx.ui.select(
    `Manage provider ${id}`,
    ["Use a model from it", "Edit", "Set key", "Test connection", "Remove"],
    {
      signal: ctx.signal,
    },
  )
  if (action === "Use a model from it") {
    const models = ctx.session.models().filter((model) => model.startsWith(`${id}/`))
    if (!models.length) {
      ctx.print(`No models configured; add one with /provider edit ${id}.`)
      return
    }
    const model = await pickModel(ctx, `Model from ${id}`, models)
    if (!model) return
    ctx.session.setModel(model)
    ctx.print(`Model: ${modelLabel(ctx.session.info().model)}`)
    return
  }
  if (action === "Edit") {
    const saved = await edit(ctx, id, a)
    if (saved) await manage(ctx, tests, saved)
    return
  }
  if (action === "Set key") return setKey(ctx, id, a)
  if (action === "Remove") return remove(ctx, id, a)
  if (action === "Test connection") return testConnection(ctx, id, a)
}

async function testConnection(ctx: CommandContext, id: string, a: ProviderAdmin) {
  const draft = a.draft(id)
  if (!draft) throw new Error(`no provider "${id}"`)
  if (!draft.models.length) {
    ctx.print(`No models configured; add one with /provider edit ${id} before testing.`)
    return
  }
  // Open on the model in use when it comes from this provider.
  const current = ctx.session.info().model
  const model = await ctx.ui.select(`Test connection for ${id}`, draft.models, {
    ...(current.provider === id && draft.models.includes(current.model) ? { initial: current.model } : {}),
    signal: ctx.signal,
  })
  if (!model) return
  const cost = a.describeModels(draft, [model])[0]?.cost
  const free = cost !== undefined && cost.input === 0 && cost.output === 0
  const ok = await ctx.ui.confirm(
    `Test ${id}/${model}?`,
    `Sends one tiny request to this model.${free ? "" : " The provider may charge for it."}`,
    { signal: ctx.signal },
  )
  if (!ok) return
  try {
    const result = await a.test(draft, model, ctx.signal)
    ctx.signal.throwIfAborted()
    ctx.print(result.message, result.ok ? "info" : "error")
  } catch (error) {
    ctx.signal.throwIfAborted()
    ctx.print(`Connection test failed: ${error instanceof Error ? error.message : String(error)}`, "error")
  }
}

/** Explicit arguments prefill the same one-page form; vendor and protocol stay editable. */
async function add(ctx: CommandContext, choice: string | undefined, a: ProviderAdmin) {
  const dialects = a.dialects()
  let initial: ProviderFormInitial = {}
  if (choice !== undefined && dialects.includes(choice)) {
    initial.dialect = choice
  } else if (choice !== undefined) {
    const vendors =
      (await a.vendors?.({ onLoading: () => ctx.print("Loading vendors from models.dev…") })) ?? []
    if (!vendors.length) {
      throw new Error(
        `Vendor catalog unavailable (offline?); cannot look up "${choice}". Choose a protocol instead: ${dialects.join(", ")}`,
      )
    }
    const vendor = vendors.find((v) => v.id === choice)
    if (!vendor) throw new Error(`unknown vendor or protocol "${choice}"; protocols: ${dialects.join(", ")}`)
    initial = providerVendorInitial(a, vendor)
  }
  const values = await ctx.ui.form(providerFormSpec(a, undefined, initial), { signal: ctx.signal })
  if (!values) {
    ctx.print("Cancelled; nothing was saved.")
    return
  }
  const draft = draftFromValues(values, undefined, initial.catalogId)
  ctx.print(await a.save(draft))
  return draft.id
}

async function edit(ctx: CommandContext, id: string, a: ProviderAdmin) {
  const existing = a.draft(id)
  if (!existing) throw new Error(`no provider "${id}"`)
  const values = await ctx.ui.form(providerFormSpec(a, existing), { signal: ctx.signal })
  if (!values) {
    ctx.print("Cancelled; nothing was changed.")
    return
  }
  ctx.print(await a.save(draftFromValues(values, id, existing.catalogId, existing)))
  return id
}

async function remove(ctx: CommandContext, id: string, a: ProviderAdmin) {
  if (ctx.session.info().model.provider === id) {
    throw new Error(`provider "${id}" is in use; switch to another model with /model first`)
  }
  const ok = await ctx.ui.confirm(`Remove provider ${id}?`, "Its entry is deleted from your settings.json.", {
    signal: ctx.signal,
    tone: "warning",
  })
  if (!ok) {
    ctx.print("Kept it.")
    return
  }
  const stored = a.storedKeyHint(id)
  const removeKey = stored
    ? (await ctx.ui.confirm(`Also delete its key (${stored}) from ~/.amira/auth.json?`, undefined, {
        signal: ctx.signal,
        tone: "warning",
      })) === true
    : false
  ctx.print(await a.remove(id, { removeKey }))
}

async function setKey(ctx: CommandContext, id: string, a: ProviderAdmin) {
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
