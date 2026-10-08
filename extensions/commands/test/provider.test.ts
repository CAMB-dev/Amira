import { expect, test } from "bun:test"
import {
  draftFromValues,
  type EventMap,
  type ProviderAdmin,
  type ProviderDraft,
  type ProviderVendor,
  providerFormSpec,
  type SessionControl,
} from "@amira/api"
import { createAi, createMockDialect } from "../../../packages/ai/src/index.ts"
import {
  Agent,
  CommandHost,
  EventBus,
  ExtensionHost,
  InterceptorRegistry,
  ToolRegistry,
} from "../../../packages/core/src/index.ts"
import commandsExtension from "../src/index.ts"

type Request = EventMap["ui.request"]

/** A ProviderAdmin that records calls. */
function fakeAdmin() {
  const calls: string[] = []
  const drafts: ProviderDraft[] = []
  const admin: ProviderAdmin = {
    vendors: async () => [],
    dialects: () => ["openai-chat", "anthropic-messages"],
    exists: (id) => id === "deepseek",
    draft: (id) =>
      id === "deepseek"
        ? {
            id,
            dialect: "openai-chat",
            baseUrl: "https://api.deepseek.com",
            keySource: "auth",
            models: ["deepseek-chat"],
            defaults: { contextWindow: 64000, thinking: true },
          }
        : undefined,
    storedKeyHint: (id) => (id === "deepseek" ? "…wxyz" : undefined),
    envIsSet: () => false,
    listModels: async (d) => {
      calls.push(`list ${d.baseUrl} key=${d.apiKey ? "typed" : "none"}`)
      return [
        { id: "deepseek-chat", contextWindow: 128000, cost: { input: 0.27, output: 1.1 }, inCatalog: true },
        { id: "deepseek-new", inCatalog: false },
      ]
    },
    describeModels: (_d, ids) => ids.map((id) => ({ id, inCatalog: false })),
    test: async (_d, model) => {
      calls.push(`test ${model}`)
      return { ok: true, latencyMs: 5, message: `OK: ${model} answered in 5 ms` }
    },
    save: async (d) => {
      drafts.push(d)
      calls.push(`save ${d.id}`)
      return `Saved provider "${d.id}".`
    },
    remove: async (id, o) => {
      calls.push(`remove ${id} key=${o.removeKey}`)
      return `Removed provider "${id}".`
    },
    setKey: async (id, key) => {
      calls.push(`key ${id} ${key.length}`)
      return `Stored a key for "${id}".`
    },
  }
  return { admin, calls, drafts }
}

type Listed = ReturnType<SessionControl["providers"]>

const CONFIGURED: Listed = [
  { id: "deepseek", dialect: "openai-chat", baseUrl: "https://api.deepseek.com", hasKey: true },
  { id: "mock", dialect: "mock", baseUrl: "", hasKey: true },
]

async function setup(
  answer: (r: Request) => unknown,
  opts: { dialogs?: boolean; current?: string; providers?: Listed; admin?: Partial<ProviderAdmin> } = {},
) {
  const bus = new EventBus()
  const ext = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  if (opts.dialogs) ext.ui.formMode = "dialogs"
  await ext.load(commandsExtension, "builtin:commands")
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const agent = new Agent({ ai, model: ai.model("mock/m"), cwd: "/work", bus })
  const { admin, calls, drafts } = fakeAdmin()
  Object.assign(admin, opts.admin)
  const control = {
    info: () => ({
      id: "s1",
      cwd: "/work",
      model: { provider: opts.current ?? "mock", model: "m" },
      contextWindow: 1000,
      busy: false,
      shell: "auto",
    }),
    setThinking: () => {},
    providers: () => opts.providers ?? CONFIGURED,
    providerAdmin: admin,
  } as unknown as SessionControl
  const host = new CommandHost({ registry: ext.commands, bus, ui: ext.ui, control, agent })
  const asked: Request[] = []
  bus.subscribe(
    (e) => {
      if (e.type !== "ui.request") return
      asked.push(e.data)
      const v = answer(e.data)
      if (v === undefined) ext.ui.cancel(e.data.requestId)
      else {
        const problem = ext.ui.respond(e.data.requestId, v)
        if (problem) throw new Error(problem)
      }
    },
    { types: ["ui.request"] },
  )
  const events: unknown[] = []
  bus.subscribe((e) => void events.push(e))
  const run = async (line: string) => {
    const r = await host.run(line, { frontend: "tui" })
    await bus.flush()
    return { ...r, text: r.output.join("\n") }
  }
  return { run, calls, drafts, asked, host, events }
}

test("/provider add falls back to the protocol picker when the catalog is unavailable", async () => {
  const { run, asked, drafts, calls } = await setup((r) => {
    if (r.kind === "select") return r.options[1]
    if (r.kind === "form") {
      return {
        id: "ds-test",
        dialect: "anthropic-messages",
        baseUrl: "https://api.deepseek.com/",
        keySource: "auth",
        apiKey: "sk-typed-123456789",
        models: ["deepseek-chat", "my-own"],
        contextWindow: 32000,
      }
    }
    return undefined
  })
  const r = await run("/provider add")
  expect(r.ok).toBe(true)
  // An empty catalog uses the existing custom protocol flow.
  expect(asked[0]).toMatchObject({
    kind: "select",
    title: "Which protocol does the provider speak?",
    options: [
      "openai-chat — OpenAI-compatible chat completions (most providers, local servers)",
      "anthropic-messages — Anthropic Messages API",
    ],
  })
  const form = asked[1] as Extract<Request, { kind: "form" }>
  expect(form.title).toBe("Add a provider")
  const dialect = form.fields.find((f) => f.id === "dialect") as Record<string, unknown>
  expect(dialect.default).toBe("anthropic-messages")
  const baseUrl = form.fields.find((f) => f.id === "baseUrl") as Record<string, unknown>
  expect(baseUrl.placeholder).toBe("https://api.example.com/v1")
  expect("default" in baseUrl).toBe(false)
  expect(form.fields.map((f) => f.id)).toEqual([
    "id",
    "dialect",
    "baseUrl",
    "keySource",
    "apiKey",
    "apiKeyEnv",
    "fetchModels",
    "models",
    "contextWindow",
    "maxOutput",
    "thinking",
    "images",
    "promptCache",
    "testConnection",
  ])
  // Nothing went out on its own: no fetch, no test.
  expect(calls).toEqual(["save ds-test"])
  expect(drafts[0]).toEqual({
    id: "ds-test",
    dialect: "anthropic-messages",
    baseUrl: "https://api.deepseek.com",
    keySource: "auth",
    apiKey: "sk-typed-123456789",
    models: ["deepseek-chat", "my-own"],
    defaults: { contextWindow: 32000, thinking: false, images: false, promptCache: false },
  })
  expect(r.text).toBe(
    'Provider catalog unavailable; choose a protocol to add a custom provider.\nSaved provider "ds-test".',
  )
})

test("/provider add <protocol> skips the question; an unknown one or a cancel saves nothing", async () => {
  const direct = await setup((r) =>
    r.kind === "form" ? { id: "x", baseUrl: "http://x", keySource: "none" } : undefined,
  )
  expect((await direct.run("/provider add anthropic-messages")).ok).toBe(true)
  expect(direct.asked.map((a) => a.kind)).toEqual(["form"])
  const form = direct.asked[0] as Extract<Request, { kind: "form" }>
  expect((form.fields.find((f) => f.id === "dialect") as Record<string, unknown>).default).toBe(
    "anthropic-messages",
  )
  expect(direct.calls).toEqual(["save x"])

  const unknown = await setup(() => undefined)
  expect((await unknown.run("/provider add deepseek")).error).toBe(
    'unknown vendor or protocol "deepseek"; protocols: openai-chat, anthropic-messages',
  )
  expect(unknown.asked).toEqual([])

  const cancelled = await setup(() => undefined)
  expect((await cancelled.run("/provider add")).text).toBe(
    "Provider catalog unavailable; choose a protocol to add a custom provider.\nCancelled; nothing was saved.",
  )
  expect(cancelled.calls).toEqual([])
})

const VENDORS: ProviderVendor[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    env: ["DEEPSEEK_API_KEY", "ALTERNATE_KEY"],
    dialect: "openai-chat",
    baseUrl: "https://api.deepseek.com",
  },
  { id: "unsupported", name: "Unsupported vendor", env: ["OTHER_API_KEY"] },
]

test("/provider add picks a vendor and saves its catalog identity after renaming", async () => {
  let loads = 0
  const { run, asked, drafts, calls } = await setup(
    (r) => {
      if (r.kind === "select") return r.options[0]
      if (r.kind === "form") return { id: "my-deepseek", models: ["deepseek-chat"] }
      return undefined
    },
    {
      admin: {
        vendors: async () => {
          loads++
          return VENDORS
        },
        envIsSet: (name) => name === "ALTERNATE_KEY",
      },
    },
  )
  expect((await run("/provider add")).text).toBe('Saved provider "my-deepseek".')
  expect(loads).toBe(1)
  expect(asked[0]).toMatchObject({
    kind: "select",
    title: "Which provider do you want to add?",
    options: [
      "DeepSeek (deepseek)",
      "Unsupported vendor (unsupported) — pick the protocol yourself",
      "Custom (choose a protocol)",
    ],
  })
  const form = asked[1] as Extract<Request, { kind: "form" }>
  const fields = Object.fromEntries(form.fields.map((f) => [f.id, f as Record<string, unknown>]))
  expect(fields.id!.default).toBe("deepseek-2")
  expect(fields.dialect!.default).toBe("openai-chat")
  expect(fields.baseUrl!.default).toBe("https://api.deepseek.com")
  expect(fields.keySource!.default).toBe("env")
  expect(fields.apiKeyEnv!.default).toBe("ALTERNATE_KEY")
  expect(fields.catalogId).toBeUndefined()
  expect(drafts[0]).toMatchObject({
    id: "my-deepseek",
    catalogId: "deepseek",
    dialect: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    keySource: "env",
    apiKeyEnv: "ALTERNATE_KEY",
  })
  expect(calls).toEqual(["save my-deepseek"])
})

test("an explicit vendor skips the picker and an unsupported vendor opens the full form", async () => {
  const { run, asked, drafts } = await setup(
    (r) =>
      r.kind === "form"
        ? { dialect: "anthropic-messages", baseUrl: "https://api.unsupported.example", models: ["m"] }
        : undefined,
    { admin: { vendors: async () => VENDORS } },
  )
  expect((await run("/provider add unsupported")).ok).toBe(true)
  expect(asked.map((r) => r.kind)).toEqual(["form"])
  const form = asked[0] as Extract<Request, { kind: "form" }>
  const fields = Object.fromEntries(form.fields.map((f) => [f.id, f as Record<string, unknown>]))
  expect(fields.id!.default).toBe("unsupported")
  expect(fields.dialect!.options).toHaveLength(2)
  expect(fields.baseUrl!.default).toBeUndefined()
  expect(fields.keySource!.default).toBe("auth")
  expect(fields.apiKeyEnv!.default).toBe("OTHER_API_KEY")
  expect(drafts[0]).toMatchObject({ id: "unsupported", dialect: "anthropic-messages" })
  expect(drafts[0]!.catalogId).toBeUndefined()
})

test("Custom keeps the prior protocol picker and cancelling the vendor picker saves nothing", async () => {
  const custom = await setup(
    (r) => {
      if (r.kind === "select") {
        return r.title === "Which provider do you want to add?" ? r.options.at(-1) : r.options[1]
      }
      if (r.kind === "form") return { id: "custom", baseUrl: "http://localhost:1234", keySource: "none" }
      return undefined
    },
    { admin: { vendors: async () => VENDORS } },
  )
  expect((await custom.run("/provider add")).ok).toBe(true)
  expect(custom.asked.map((r) => r.kind)).toEqual(["select", "select", "form"])
  expect(custom.asked[1]!.title).toBe("Which protocol does the provider speak?")
  expect(custom.drafts[0]).toMatchObject({ dialect: "anthropic-messages", keySource: "none" })
  expect(custom.drafts[0]!.catalogId).toBeUndefined()

  const cancelled = await setup(() => undefined, { admin: { vendors: async () => VENDORS } })
  expect((await cancelled.run("/provider add")).text).toBe("Cancelled; nothing was saved.")
  expect(cancelled.asked).toHaveLength(1)
  expect(cancelled.calls).toEqual([])
})

test("an explicit protocol wins a vendor-id clash without fetching the catalog", async () => {
  let loads = 0
  const { run, asked, drafts } = await setup(
    (r) => (r.kind === "form" ? { id: "x", baseUrl: "http://x", keySource: "none" } : undefined),
    {
      admin: {
        vendors: async () => {
          loads++
          return [{ id: "openai-chat", name: "Clash", env: [] }]
        },
      },
    },
  )
  expect((await run("/provider add openai-chat")).ok).toBe(true)
  expect(loads).toBe(0)
  expect(asked.map((r) => r.kind)).toEqual(["form"])
  expect(drafts[0]!.catalogId).toBeUndefined()
})

test("older admins without vendors fall back to the protocol picker", async () => {
  const { run, asked } = await setup(() => undefined, { admin: { vendors: undefined } })
  expect((await run("/provider add")).text).toContain("Provider catalog unavailable")
  expect(asked[0]!.title).toBe("Which protocol does the provider speak?")
})

test("/provider edit preserves catalog identity, including explicit opt-out", async () => {
  for (const catalogId of ["vendor", false] as const) {
    const { admin } = fakeAdmin()
    const existing = admin.draft("deepseek")!
    const { run, drafts } = await setup(
      (r) => (r.kind === "form" ? { baseUrl: "https://api.deepseek.com/v1" } : undefined),
      { admin: { draft: () => ({ ...existing, catalogId }) } },
    )
    expect((await run("/provider edit deepseek")).ok).toBe(true)
    expect(drafts[0]!.catalogId).toBe(catalogId)
  }
})

test("/provider lists only configured providers; with none it says how to add one", async () => {
  const some = await setup(() => undefined)
  const listed = (await some.run("/provider")).text
  expect(listed).toContain("deepseek")
  for (const name of ["anthropic", "openai-chat ", "google", "ollama", "presets"]) {
    expect(listed.split("\n").some((l) => l.trim().startsWith(name))).toBe(false)
  }
  const none = await setup(() => undefined, { providers: [] })
  expect((await none.run("/provider")).text).toBe("No providers configured — add one with /provider add")
  expect((await none.run("/provider edit anthropic")).error).toBe(
    "No providers configured — add one with /provider add",
  )
})

test("the form refuses an id that exists and a base URL that is no URL", async () => {
  const { admin } = fakeAdmin()
  const bus = new EventBus()
  const ext = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  const pending = ext.ui.api().form(providerFormSpec(admin))
  await bus.flush()
  const id = ext.ui.pending[0]!.requestId
  expect(ext.ui.validateForm(id, { id: "deepseek", baseUrl: "api.x" })).toEqual({
    id: '"deepseek" exists already; change it with /provider edit deepseek',
    baseUrl: "must be a URL, e.g. https://api.example.com/v1",
  })
  const fetched = await ext.ui.runFormAction(id, "fetchModels", {
    baseUrl: "https://api.deepseek.com",
    apiKey: "k",
  })
  expect(fetched.message).toBe("Found 2 models; 1 are in the model catalog. Pick them in the list below.")
  expect(fetched.options?.models).toEqual([
    { value: "deepseek-chat", description: "128k ctx · $0.27/$1.1 per M" },
    { value: "deepseek-new", description: "not in catalog: defaults apply" },
  ])
  const tested = await ext.ui.runFormAction(id, "testConnection", {})
  expect(tested).toEqual({ message: "Pick or type a model first.", tone: "warning" })
  ext.ui.cancel(id)
  expect(await pending).toBeUndefined()
})

test("step by step, fetching models is offered first and the connection test defaults to no", async () => {
  const answers: Record<string, unknown> = {}
  const { run, asked, calls, drafts } = await setup(
    (r) => {
      if (answers[r.title] !== undefined) return answers[r.title]
      if (r.kind === "input") {
        if (r.title.includes("· Id")) return "ds-test"
        if (r.title.includes("· Base URL")) return "https://api.deepseek.com"
        if (r.title.includes("· API key")) return r.secret ? "sk-step-123456789" : undefined
        return undefined
      }
      if (r.kind !== "select") return undefined
      if (r.title.includes("· Models")) {
        return r.options.includes("[ ] deepseek-chat") ? "[ ] deepseek-chat" : "Done"
      }
      // Every other question takes its default, the first option.
      return r.options[0]
    },
    { dialogs: true },
  )
  const r = await run("/provider add")
  expect(r.ok).toBe(true)
  const titles = asked.map((a) =>
    `${a.title.split("\n").at(-1)} ${a.kind === "select" ? `[${a.options.slice(0, 3).join("|")}]` : ""}`.trim(),
  )
  expect(titles.find((t) => t.startsWith("Fetch models?"))).toContain("[Yes|No]")
  expect(titles.find((t) => t.startsWith("Test connection?"))).toContain("[No|Yes]")
  expect(calls).toEqual(["list https://api.deepseek.com key=typed", "save ds-test"])
  expect(drafts[0]).toMatchObject({ id: "ds-test", keySource: "auth", models: ["deepseek-chat"] })
  const secret = asked.find((a) => a.kind === "input" && a.secret)
  expect(secret).toBeDefined()
})

test("/provider edit prefills the form, without the key", async () => {
  let seen: Extract<Request, { kind: "form" }> | undefined
  const { run, drafts } = await setup((r) => {
    if (r.kind !== "form") return undefined
    seen = r
    return { baseUrl: "https://api.deepseek.com/v1" }
  })
  const r = await run("/provider edit deepseek")
  expect(r.ok).toBe(true)
  expect(seen!.title).toBe("Edit provider deepseek")
  const byId = Object.fromEntries(seen!.fields.map((f) => [f.id, f as Record<string, unknown>]))
  expect(byId.id).toBeUndefined()
  expect(byId.baseUrl!.default).toBe("https://api.deepseek.com")
  expect(byId.models!.default).toEqual(["deepseek-chat"])
  expect(byId.contextWindow!.default).toBe(64000)
  expect(byId.thinking!.default).toBe(true)
  expect("default" in byId.apiKey!).toBe(false)
  expect(byId.apiKey!.placeholder).toContain("…wxyz")
  // An empty key keeps the stored one.
  expect(drafts[0]).toMatchObject({
    id: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    keySource: "auth",
  })
  expect("apiKey" in drafts[0]!).toBe(false)
  expect((await run("/provider edit nope")).error).toContain('no provider "nope"')
})

test("/provider remove asks, refuses the provider in use, and asks about the stored key", async () => {
  const yes = await setup((r) => (r.kind === "confirm" ? true : undefined))
  expect((await yes.run("/provider remove deepseek")).text).toBe('Removed provider "deepseek".')
  expect(yes.calls).toEqual(["remove deepseek key=true"])
  expect(yes.asked.map((a) => a.title)).toEqual([
    "Remove provider deepseek?",
    "Also delete its key (…wxyz) from ~/.amira/auth.json?",
  ])

  const no = await setup((r) => (r.kind === "confirm" ? false : undefined))
  expect((await no.run("/provider remove deepseek")).text).toBe("Kept it.")
  expect(no.calls).toEqual([])

  const inUse = await setup(() => true, { current: "deepseek" })
  expect((await inUse.run("/provider remove deepseek")).error).toContain("is in use")
})

test("/provider key asks with a masked input and never echoes the key", async () => {
  const { run, calls, asked, events } = await setup((r) =>
    r.kind === "input" ? "sk-new-secret-000" : undefined,
  )
  const r = await run("/provider key deepseek")
  expect(r.text).toBe('Stored a key for "deepseek".')
  expect(asked[0]).toMatchObject({
    kind: "input",
    secret: true,
    title: "API key for deepseek (replaces …wxyz)",
  })
  expect(calls).toEqual(["key deepseek 17"])
  expect(JSON.stringify(events)).not.toContain("sk-new-secret")
})

test("completion offers the subcommands, protocols and provider ids", async () => {
  const { host } = await setup(() => undefined)
  const values = async (line: string) => (await host.complete(line)).candidates.map((c) => c.value)
  expect(await values("/provider ")).toEqual(["add", "edit", "remove", "key"])
  expect(await values("/provider add ")).toEqual(["add openai-chat", "add anthropic-messages"])
  expect(await values("/provider edit ")).toEqual(["edit deepseek", "edit mock"])
})

test("draftFromValues trims the base URL and keeps only the key of the chosen source", () => {
  expect(
    draftFromValues({
      id: "x",
      dialect: "openai-chat",
      baseUrl: " https://h/v1/ ",
      keySource: "env",
      apiKey: "k",
      apiKeyEnv: "V",
    }),
  ).toMatchObject({ baseUrl: "https://h/v1", keySource: "env", apiKeyEnv: "V" })
  expect("apiKey" in draftFromValues({ keySource: "env", apiKey: "k" })).toBe(false)
})
