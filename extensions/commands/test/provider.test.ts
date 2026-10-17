import { expect, test } from "bun:test"
import {
  type CommandFrontend,
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
import { ProviderConnectionTests } from "../src/provider-tests.ts"

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
  opts: {
    dialogs?: boolean
    current?: string
    providers?: Listed
    admin?: Partial<ProviderAdmin>
    sessionId?: () => string
    afterSave?: boolean
  } = {},
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
  const selectedModels: string[] = []
  const control = {
    models: () => ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner", "mock/m"],
    setModel: (model: string) => selectedModels.push(model),
    info: () => ({
      id: opts.sessionId?.() ?? "s1",
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
      const respond = (value: unknown) => {
        if (value === undefined) ext.ui.cancel(e.data.requestId)
        else {
          // Native client fixtures explicitly consent to the Save-time probe.
          const problem = ext.ui.respond(
            e.data.requestId,
            e.data.kind === "form" ? { testConsent: true, ...(value as object) } : value,
          )
          if (problem) throw new Error(problem)
        }
      }
      const v =
        e.data.kind === "select" && e.data.title === "Providers" && e.data.initial && !opts.afterSave
          ? undefined
          : answer(e.data)
      if (v instanceof Promise) return v.then(respond)
      respond(v)
    },
    { types: ["ui.request"] },
  )
  const events: unknown[] = []
  bus.subscribe((e) => void events.push(e))
  const run = async (line: string, frontend: CommandFrontend = "tui", signal?: AbortSignal) => {
    const r = await host.run(line, { frontend, signal })
    await bus.flush()
    return { ...r, text: r.output.join("\n") }
  }
  return { run, calls, drafts, asked, host, events, bus, selectedModels, ui: ext.ui }
}

test("/provider add opens one form immediately with editable vendor and protocol", async () => {
  let loads = 0
  const { run, asked, drafts } = await setup(
    (r) =>
      r.kind === "form"
        ? {
            id: "ds-test",
            dialect: "anthropic-messages",
            baseUrl: "https://api.deepseek.com/",
            keySource: "auth",
            apiKey: "sk-typed-123456789",
            models: ["deepseek-chat", "my-own"],
            contextWindow: 32000,
          }
        : undefined,
    {
      admin: {
        vendors: async () => {
          loads++
          return []
        },
      },
    },
  )
  const result = await run("/provider add")
  expect(result.ok).toBe(true)
  expect(loads).toBe(0)
  const form = asked[0] as Extract<Request, { kind: "form" }>
  expect(form.title).toBe("Add provider")
  expect(form.fields[0]).toMatchObject({ id: "vendor", type: "select" })
  expect(form.fields.find((f) => f.id === "dialect")).toMatchObject({ type: "select" })
  expect(drafts[0]).toMatchObject({
    id: "ds-test",
    dialect: "anthropic-messages",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-chat", "my-own"],
  })
  expect(asked.at(-1)).toMatchObject({ title: "Providers", initial: "ds-test" })
  expect(result.text).toBe('Saved provider "ds-test".')
})

test("/provider add <protocol> skips the question; an unknown one or a cancel saves nothing", async () => {
  const direct = await setup((r) =>
    r.kind === "form" ? { id: "x", baseUrl: "http://x", keySource: "none" } : undefined,
  )
  expect((await direct.run("/provider add anthropic-messages")).ok).toBe(true)
  expect(direct.asked.map((a) => a.kind)).toEqual(["form", "select"])
  const form = direct.asked[0] as Extract<Request, { kind: "form" }>
  expect((form.fields.find((f) => f.id === "dialect") as Record<string, unknown>).default).toBe(
    "anthropic-messages",
  )
  expect(direct.calls).toEqual(["save x"])

  const unknown = await setup(() => undefined)
  expect((await unknown.run("/provider add deepseek")).error).toBe(
    'Vendor catalog unavailable (offline?); cannot look up "deepseek". Choose a protocol instead: openai-chat, anthropic-messages',
  )
  expect(unknown.asked).toEqual([])

  const cancelled = await setup(() => undefined)
  expect((await cancelled.run("/provider add")).text).toBe("Cancelled; nothing was saved.")
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

test("an explicit vendor prefills the single form and preserves catalog identity after renaming", async () => {
  let loads = 0
  const { run, asked, drafts } = await setup(
    (r) => (r.kind === "form" ? { id: "my-deepseek", models: ["deepseek-chat"] } : undefined),
    {
      admin: {
        cachedVendors: () => VENDORS,
        vendors: async () => {
          loads++
          return VENDORS
        },
        envIsSet: (name) => name === "ALTERNATE_KEY",
      },
    },
  )
  expect((await run("/provider add deepseek")).text).toBe('Saved provider "my-deepseek".')
  expect(loads).toBe(1)
  const form = asked[0] as Extract<Request, { kind: "form" }>
  expect(form.fields.find((f) => f.id === "id")).toMatchObject({ default: "deepseek-2" })
  expect(form.fields.find((f) => f.id === "apiKeyEnv")).toMatchObject({ default: "ALTERNATE_KEY" })
  expect(drafts[0]).toMatchObject({
    id: "my-deepseek",
    catalogId: "deepseek",
    keySource: "env",
    apiKeyEnv: "ALTERNATE_KEY",
  })
})

test("an unavailable catalog explains positional vendor lookup failures", async () => {
  const unavailable = await setup(() => undefined, { admin: { vendors: async () => [] } })
  const result = await unavailable.run("/provider add deepseek")
  expect(result.error).toContain("Vendor catalog unavailable (offline?)")
  expect(result.error).toContain("Choose a protocol instead: openai-chat")
  expect(result.error).not.toContain("unknown vendor or protocol")
  expect(unavailable.asked).toEqual([])
  const available = await setup(() => undefined, { admin: { vendors: async () => VENDORS } })
  expect((await available.run("/provider add not-a-vendor")).error).toContain("unknown vendor or protocol")
})

test("loading vendors is printed while the catalog request is still pending", async () => {
  const started = Promise.withResolvers<void>()
  const loaded = Promise.withResolvers<void>()
  const session = await setup(() => undefined, {
    admin: {
      vendors: async (opts) => {
        opts?.onLoading?.()
        started.resolve()
        await loaded.promise
        return VENDORS
      },
    },
  })
  const running = session.run("/provider add deepseek")
  await started.promise
  try {
    await session.bus.flush()
    expect(session.events).toContainEqual(
      expect.objectContaining({
        type: "command.output",
        data: expect.objectContaining({ text: "Loading vendors from models.dev…" }),
      }),
    )
    expect(session.asked).toEqual([])
  } finally {
    loaded.resolve()
  }
  expect((await running).text).toBe("Loading vendors from models.dev…\nCancelled; nothing was saved.")
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
  expect(asked.map((r) => r.kind)).toEqual(["form", "select"])
  const form = asked[0] as Extract<Request, { kind: "form" }>
  const fields = Object.fromEntries(form.fields.map((f) => [f.id, f as Record<string, unknown>]))
  expect(fields.id!.default).toBe("unsupported")
  expect(fields.dialect!.options).toHaveLength(2)
  expect(fields.baseUrl!.default).toBeUndefined()
  expect(fields.keySource!.default).toBe("auth")
  expect(fields.apiKeyEnv!.default).toBe("OTHER_API_KEY")
  expect(drafts[0]).toMatchObject({ id: "unsupported", dialect: "anthropic-messages" })
  expect(drafts[0]!.catalogId).toBe("unsupported")
})

test("Custom keeps protocol editable in the form and cancelling saves nothing", async () => {
  const custom = await setup(
    (r) =>
      r.kind === "form"
        ? {
            id: "custom",
            dialect: "anthropic-messages",
            baseUrl: "http://localhost:1234",
            keySource: "none",
          }
        : undefined,
    { admin: { cachedVendors: () => VENDORS } },
  )
  expect((await custom.run("/provider add")).ok).toBe(true)
  expect(custom.asked.map((r) => r.kind)).toEqual(["form", "select"])
  expect(custom.drafts[0]).toMatchObject({ dialect: "anthropic-messages", keySource: "none" })
  expect(custom.drafts[0]!.catalogId).toBe(false)
  const cancelled = await setup(() => undefined)
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
  expect(asked.map((r) => r.kind)).toEqual(["form", "select"])
  expect(drafts[0]!.catalogId).toBe(false)
})

test("older admins without vendors open a Custom form without a network wait", async () => {
  const { run, asked } = await setup(() => undefined, { admin: { vendors: undefined } })
  expect((await run("/provider add")).text).toBe("Cancelled; nothing was saved.")
  expect(asked[0]).toMatchObject({ kind: "form", title: "Add provider" })
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

test("print and RPC /provider keep the exact original table and empty output without dialogs", async () => {
  for (const frontend of ["print", "rpc"] as const) {
    const some = await setup(() => undefined)
    const listed = await some.run("/provider", frontend)
    expect(listed.ok).toBe(true)
    expect(listed.text).toBe(
      "Providers:\n   deepseek  openai-chat  https://api.deepseek.com  key set\n*  mock      mock                                   key set\nAdd one with /provider add; change one with /provider edit <id>.",
    )
    expect(some.asked).toEqual([])
    expect(some.calls).toEqual([])
    const none = await setup(() => undefined, { providers: [] })
    expect((await none.run("/provider", frontend)).text).toBe(
      "No providers configured — add one with /provider add",
    )
    expect(none.asked).toEqual([])
    expect((await none.run("/provider edit anthropic", frontend)).error).toBe(
      "No providers configured — add one with /provider add",
    )

    const missingKey = await setup(() => undefined, {
      providers: [
        {
          id: "custom",
          dialect: "openai-chat",
          baseUrl: "http://localhost:1234",
          hasKey: false,
          apiKeyEnv: "CUSTOM_KEY",
        },
      ],
    })
    expect((await missingKey.run("/provider", frontend)).text).toBe(
      "Providers:\n   custom  openai-chat  http://localhost:1234  no key (CUSTOM_KEY)\nAdd one with /provider add; change one with /provider edit <id>.",
    )
    expect(missingKey.asked).toEqual([])
  }
})

test("TUI /provider opens a management page with Add first and configured provider metadata", async () => {
  const { admin } = fakeAdmin()
  const existing = admin.draft("deepseek")!
  const longUrl = `https://api.example.com/${"long-path/".repeat(8)}`
  const session = await setup(() => undefined, {
    providers: [
      CONFIGURED[0]!,
      { id: "env", dialect: "anthropic-messages", baseUrl: longUrl, hasKey: true, apiKeyEnv: "ENV_KEY" },
      { id: "local", dialect: "openai-chat", baseUrl: "http://localhost:1234/v1/", hasKey: true },
    ],
    admin: {
      draft: (id) =>
        id === "deepseek"
          ? existing
          : {
              id,
              dialect: "openai-chat",
              baseUrl: id === "env" ? longUrl : "http://localhost:1234/v1/",
              keySource: id === "env" ? "env" : "none",
              ...(id === "env" ? { apiKeyEnv: "ENV_KEY" } : {}),
              models: id === "env" ? ["a", "b"] : [],
            },
    },
  })
  expect((await session.run("/provider")).text).toBe("")
  expect(session.asked).toHaveLength(1)
  expect(session.asked[0]).toMatchObject({
    kind: "select",
    title: "Providers",
    options: ["+ Add provider", "deepseek", "env", "local"],
    sections: [
      { at: 0, choose: "add" },
      { at: 1, title: "Configured", choose: "manage" },
    ],
    descriptions: [
      "Configure a provider and its models",
      "openai-chat · api.deepseek.com · 1 model · key: auth.json",
      `anthropic-messages · ${longUrl.replace("https://", "").slice(0, 41)}… · 2 models · key: env (ENV_KEY)`,
      "openai-chat · localhost:1234/v1 · 0 models · key: none",
    ],
  })
  expect(session.calls).toEqual([])
})

test("the empty management page offers Add and Escape cancels without changing providers", async () => {
  const session = await setup(() => undefined, { providers: [] })
  expect((await session.run("/provider")).ok).toBe(true)
  expect(session.asked[0]).toMatchObject({
    title: "Providers",
    options: ["+ Add provider"],
    sections: [{ at: 0, choose: "add" }],
  })
  expect(session.calls).toEqual([])
})

test("management Add opens the single provider form and returns with the saved id highlighted", async () => {
  const session = await setup(
    (r) => {
      if (r.kind === "select") return r.options[0]
      if (r.kind === "form") return { id: "new", baseUrl: "http://localhost:1234", keySource: "none" }
      return undefined
    },
    { providers: [] },
  )
  expect((await session.run("/provider")).text).toBe('Saved provider "new".')
  expect(session.asked.map((r) => r.title)).toEqual(["Providers", "Add provider", "Providers"])
  expect(session.asked.at(-1)).toMatchObject({ initial: "new" })
  expect(session.calls).toEqual(["save new"])
})

test("Escape in management Add saves nothing", async () => {
  const session = await setup((r) => (r.kind === "select" ? "+ Add provider" : undefined))
  expect((await session.run("/provider")).text).toBe("Cancelled; nothing was saved.")
  expect(session.asked).toHaveLength(2)
  expect(session.calls).toEqual([])
})

test("management Edit and Set key reuse existing forms and masked input", async () => {
  for (const action of ["Edit", "Set key"]) {
    const session = await setup((r) => {
      if (r.kind === "select") return r.title === "Providers" ? "deepseek" : action
      if (r.kind === "form") return { baseUrl: "https://api.deepseek.com/v1" }
      if (r.kind === "input") return "sk-management-secret"
      return undefined
    })
    expect((await session.run("/provider")).ok).toBe(true)
    expect(session.asked[1]).toMatchObject({
      title: "Manage provider deepseek",
      options: ["Use a model from it", "Edit", "Set key", "Test connection", "Remove"],
    })
    if (action === "Edit") {
      expect(session.asked[2]).toMatchObject({ kind: "form", title: "Edit provider · deepseek" })
      expect(session.calls).toEqual(["test deepseek-chat", "save deepseek"])
      expect(session.drafts[0]).toMatchObject({
        id: "deepseek",
        models: ["deepseek-chat"],
        keySource: "auth",
      })
    } else {
      expect(session.asked[2]).toMatchObject({ kind: "input", secret: true })
      expect(session.calls).toEqual(["key deepseek 20"])
      expect(JSON.stringify(session.events)).not.toContain("sk-management-secret")
    }
  }
})

test("Escape in the action menu, edit form, or key input changes nothing", async () => {
  for (const action of [undefined, "Edit", "Set key"]) {
    const session = await setup((r) =>
      r.kind === "select" ? (r.title === "Providers" ? "deepseek" : action) : undefined,
    )
    expect((await session.run("/provider")).ok).toBe(true)
    expect(session.calls).toEqual([])
    expect(session.asked).toHaveLength(action ? 3 : 2)
  }
})

test("management Remove preserves confirmation, optional key removal, and the in-use guard", async () => {
  for (const removeKey of [true, false, undefined]) {
    const session = await setup((r) => {
      if (r.kind === "select") return r.title === "Providers" ? "deepseek" : "Remove"
      if (r.kind === "confirm") return r.title.startsWith("Also") ? removeKey : true
      return undefined
    })
    expect((await session.run("/provider")).text).toBe('Removed provider "deepseek".')
    expect(session.calls).toEqual([`remove deepseek key=${removeKey === true}`])
    expect(session.asked.slice(2).map((r) => r.title)).toEqual([
      "Remove provider deepseek?",
      "Also delete its key (…wxyz) from ~/.amira/auth.json?",
    ])
  }
  for (const answer of [false, undefined]) {
    const session = await setup((r) =>
      r.kind === "select" ? (r.title === "Providers" ? "deepseek" : "Remove") : answer,
    )
    expect((await session.run("/provider")).text).toBe("Kept it.")
    expect(session.calls).toEqual([])
  }
  const inUse = await setup(
    (r) => (r.kind === "select" ? (r.title === "Providers" ? "deepseek" : "Remove") : true),
    { current: "deepseek" },
  )
  expect((await inUse.run("/provider")).error).toContain("is in use")
  expect(inUse.asked).toHaveLength(2)
  expect(inUse.calls).toEqual([])
})

test("management labels fallback-only environment credentials without an undefined variable", async () => {
  const existing = fakeAdmin().admin.draft("deepseek")!
  const session = await setup(() => undefined, {
    admin: { draft: () => ({ ...existing, keySource: "env" }) },
  })
  await session.run("/provider")
  const page = session.asked[0]
  if (page?.kind !== "select") throw new Error("Missing provider page")
  expect(page.descriptions?.[1]).toContain("key: env")
  expect(page.descriptions?.[1]).not.toContain("undefined")
})

test("management connection test picks a configured model, confirms cost, and remembers success", async () => {
  const existing = fakeAdmin().admin.draft("deepseek")!
  let tested: { draft: ProviderDraft; model: string; signal?: AbortSignal } | undefined
  let visits = 0
  const session = await setup(
    (r) => {
      if (r.kind === "select") {
        if (r.title === "Providers") return ++visits === 1 ? "deepseek" : undefined
        if (r.title.startsWith("Manage")) return "Test connection"
        return r.options[1]
      }
      return r.kind === "confirm" ? true : undefined
    },
    {
      admin: {
        draft: () => ({ ...existing, models: ["deepseek-chat", "deepseek-reasoner"] }),
        test: async (draft, model, signal) => {
          tested = { draft, model, signal }
          return { ok: true, latencyMs: 7, message: "OK: connection works" }
        },
      },
    },
  )
  expect((await session.run("/provider")).text).toBe("OK: connection works")
  expect(tested?.model).toBe("deepseek-reasoner")
  expect(tested?.draft).toMatchObject({
    id: "deepseek",
    keySource: "auth",
    models: ["deepseek-chat", "deepseek-reasoner"],
  })
  expect(tested?.signal).toBeInstanceOf(AbortSignal)
  expect(session.asked[3]).toMatchObject({
    kind: "confirm",
    title: "Test deepseek/deepseek-reasoner?",
    message: "Sends one tiny request to this model. The provider may charge for it.",
  })
  expect((await session.run("/provider")).text).toBe("")
  expect(session.asked[4]).toMatchObject({
    descriptions: expect.arrayContaining([expect.stringContaining("test: passed (deepseek-reasoner, 7 ms)")]),
  })
  expect(session.calls).toEqual([])
  expect((await session.run("/provider", "rpc")).text).not.toContain("test:")
  const other = await setup(() => undefined)
  await other.run("/provider")
  expect(JSON.stringify(other.asked)).not.toContain("test: passed")
})

test("connection-test status stays with its session when commands survive new/resume", async () => {
  let id = "s1"
  let visits = 0
  const session = await setup(
    (request) => {
      if (request.kind === "select") {
        if (request.title === "Providers") return ++visits === 1 ? "deepseek" : undefined
        return request.title.startsWith("Manage") ? "Test connection" : request.options[0]
      }
      return request.kind === "confirm" ? true : undefined
    },
    { sessionId: () => id },
  )
  await session.run("/provider")
  id = "s2"
  await session.run("/provider")
  expect(JSON.stringify(session.asked.at(-1))).not.toContain("test: passed")
  id = "s1"
  await session.run("/provider")
  expect(JSON.stringify(session.asked.at(-1))).toContain("test: passed")
})

test("connection-test failed results and rejections show errors and remembered failed status", async () => {
  for (const rejects of [false, true]) {
    let visits = 0
    const session = await setup(
      (r) => {
        if (r.kind === "select") {
          if (r.title === "Providers") return ++visits === 1 ? "deepseek" : undefined
          return r.title.startsWith("Manage") ? "Test connection" : r.options[0]
        }
        return r.kind === "confirm" ? true : undefined
      },
      {
        admin: {
          test: async () => {
            if (rejects) throw new Error("Endpoint unavailable")
            return { ok: false, latencyMs: 9, message: "Authentication failed" }
          },
        },
      },
    )
    const result = await session.run("/provider")
    expect(result.ok).toBe(true)
    expect(result.text).toBe(
      rejects ? "Connection test failed: Endpoint unavailable" : "Authentication failed",
    )
    expect(session.events).toContainEqual(
      expect.objectContaining({
        type: "command.output",
        data: expect.objectContaining({ level: "error", text: result.text }),
      }),
    )
    await session.run("/provider")
    expect(session.asked[4]).toMatchObject({
      descriptions: expect.arrayContaining([expect.stringContaining("test: failed (deepseek-chat")]),
    })
    expect(session.calls).toEqual([])
  }
})

test("an aborted connection test that resolves cannot overwrite a previous success", async () => {
  const controller = new AbortController()
  let visits = 0
  let attempts = 0
  const session = await setup(
    (request) => {
      if (request.kind === "select") {
        if (request.title === "Providers") return ++visits <= 2 ? "deepseek" : undefined
        return request.title.startsWith("Manage") ? "Test connection" : request.options[0]
      }
      return request.kind === "confirm" ? true : undefined
    },
    {
      admin: {
        test: async () => {
          if (++attempts === 1) return { ok: true, latencyMs: 5, message: "First passed" }
          controller.abort()
          return { ok: false, latencyMs: 10, message: "Aborted probe resolved as failed" }
        },
      },
    },
  )
  await session.run("/provider")
  const cancelled = await session.run("/provider", "tui", controller.signal)
  expect(cancelled.text).not.toContain("Aborted probe resolved as failed")
  await session.run("/provider")
  expect(JSON.stringify(session.asked.at(-1))).toContain("test: passed")
  expect(JSON.stringify(session.asked.at(-1))).not.toContain("test: failed")
})

test("Edit-form connection tests replace the management result only for the saved configuration", async () => {
  for (const changed of [
    {},
    { baseUrl: "https://other.example/v1" },
    { apiKey: "unsaved-secret" },
    { models: ["new-model"] },
    { keySource: "env", apiKeyEnv: "OTHER_KEY" },
  ]) {
    let attempts = 0
    let visits = 0
    let action: unknown
    const session = await setup(
      (request) => {
        if (request.kind === "select") {
          if (request.title === "Providers") return ++visits === 1 ? "deepseek" : undefined
          return request.title.startsWith("Manage") ? "Test connection" : request.options[0]
        }
        if (request.kind === "form")
          return session.ui
            .runFormAction(request.requestId, "testConnection", { ...changed, testConsent: true })
            .then((result) => {
              action = result
            })
        return request.kind === "confirm" ? true : undefined
      },
      {
        admin: {
          test: async () => ({
            ok: ++attempts === 1,
            latencyMs: 7,
            message: attempts === 1 ? "Passed" : "Edit failed",
          }),
        },
      },
    )
    await session.run("/provider")
    await session.run("/provider edit deepseek")
    expect(action).toEqual({
      message:
        "Connection test failed. Fix the protocol, base URL, key or model and retry, or select Save anyway.",
      tone: "error",
      values: { saveAnyway: false },
    })
    expect(session.drafts).toEqual([])
    await session.run("/provider")
    const status = JSON.stringify(session.asked.at(-1))
    expect(status).toContain(Object.keys(changed).length ? "test: passed" : "test: failed")
  }
})

test.each(["", "   "])(
  "Edit testing and saving a blank key %j retain the saved credential and successful status",
  async (apiKey) => {
    let visits = 0
    let action: unknown
    const tested: ProviderDraft[] = []
    const session = await setup(
      (request) => {
        if (request.kind === "select") {
          if (request.title === "Providers") return ++visits <= 2 ? "deepseek" : undefined
          if (request.title.startsWith("Manage")) return visits === 1 ? "Test connection" : "Edit"
          return request.options[0]
        }
        if (request.kind === "form")
          return session.ui
            .runFormAction(request.requestId, "testConnection", { apiKey, testConsent: true })
            .then((result) => {
              action = result
              return { apiKey }
            })
        return request.kind === "confirm" ? true : undefined
      },
      {
        admin: {
          test: async (draft) => {
            tested.push(draft)
            return {
              ok: draft.apiKey === undefined,
              latencyMs: 5,
              message: draft.apiKey === undefined ? "Saved key passed" : "Alternate key failed",
            }
          },
        },
      },
    )
    expect((await session.run("/provider")).text).toBe("Saved key passed")
    expect((await session.run("/provider")).text).toBe('Saved provider "deepseek".')
    expect(action).toEqual({ message: "Connection test passed.", tone: "success" })
    expect(tested).toHaveLength(2)
    for (const draft of tested) expect(draft).not.toHaveProperty("apiKey")
    expect(session.drafts).toHaveLength(1)
    expect(session.drafts[0]).not.toHaveProperty("apiKey")
    await session.run("/provider")
    const status = JSON.stringify(session.asked.at(-1))
    expect(status).toContain("test: passed (deepseek-chat, 5 ms)")
    expect(status).not.toContain("test: failed")
  },
)

test.each([
  { apiKey: "", expected: undefined },
  { apiKey: "   ", expected: undefined },
  { apiKey: "  replacement-secret \t", expected: "replacement-secret" },
])("recorder normalizes direct-admin test and save key $apiKey", async ({ apiKey, expected }) => {
  const { admin, drafts } = fakeAdmin()
  const existing = admin.draft("deepseek")!
  const tested: ProviderDraft[] = []
  admin.test = async (draft) => {
    tested.push(draft)
    return { ok: draft.apiKey === undefined, latencyMs: 5, message: "Tested" }
  }
  const tests = new ProviderConnectionTests()
  const tracked = tests.wrap("s1", admin)
  await tracked.test(existing, "deepseek-chat")
  const savedStatus = "test: passed (deepseek-chat, 5 ms)"
  expect(tests.status("s1", admin, existing.id)).toBe(savedStatus)
  const input = { ...existing, apiKey }
  const result = await tracked.test(input, "deepseek-chat")
  expect(result.ok).toBe(expected === undefined)
  expect(tests.status("s1", admin, existing.id)).toBe(savedStatus)
  expect(tested.at(-1)?.apiKey).toBe(expected)
  if (expected === undefined) expect(tested.at(-1)).not.toHaveProperty("apiKey")
  await tracked.save(input)
  expect(drafts.at(-1)?.apiKey).toBe(expected)
  if (expected === undefined) expect(drafts.at(-1)).not.toHaveProperty("apiKey")
  expect(tests.status("s1", admin, existing.id)).toBe(expected === undefined ? savedStatus : undefined)
  expect(input.apiKey).toBe(apiKey)
})

test("changing a saved provider's connection configuration hides its old status", async () => {
  const existing = fakeAdmin().admin.draft("deepseek")!
  let baseUrl = existing.baseUrl
  let visits = 0
  const session = await setup(
    (request) => {
      if (request.kind === "select") {
        if (request.title === "Providers") return ++visits === 1 ? "deepseek" : undefined
        return request.title.startsWith("Manage") ? "Test connection" : request.options[0]
      }
      return request.kind === "confirm" ? true : undefined
    },
    { admin: { draft: () => ({ ...existing, baseUrl }) } },
  )
  await session.run("/provider")
  baseUrl = "https://changed.example/v1"
  await session.run("/provider")
  expect(JSON.stringify(session.asked.at(-1))).not.toContain("test: passed")
})

test("saving a replacement key invalidates a test result even when its key hint is unchanged", async () => {
  let visits = 0
  const session = await setup(
    (request) => {
      if (request.kind === "select") {
        if (request.title === "Providers") return ++visits === 1 ? "deepseek" : undefined
        return request.title.startsWith("Manage") ? "Test connection" : request.options[0]
      }
      if (request.kind === "form") return { apiKey: "local-new" }
      return request.kind === "confirm" ? true : undefined
    },
    { admin: { storedKeyHint: () => "(set)" } },
  )
  await session.run("/provider")
  await session.run("/provider edit deepseek")
  expect(session.drafts.at(-1)?.apiKey).toBe("local-new")
  await session.run("/provider")
  expect(JSON.stringify(session.asked.at(-1))).not.toContain("test: passed")
})

test("connection test with no configured models, model Escape, or declined confirmation makes no request", async () => {
  for (const stop of ["no-models", "model-escape", "decline", "confirm-escape"]) {
    const existing = fakeAdmin().admin.draft("deepseek")!
    const session = await setup(
      (r) => {
        if (r.kind === "select") {
          if (r.title === "Providers") return "deepseek"
          if (r.title.startsWith("Manage")) return "Test connection"
          return stop === "model-escape" ? undefined : r.options[0]
        }
        return stop === "decline" ? false : undefined
      },
      { admin: { draft: () => ({ ...existing, models: stop === "no-models" ? [] : existing.models }) } },
    )
    const result = await session.run("/provider")
    expect(result.ok).toBe(true)
    expect(result.text).toBe(
      stop === "no-models"
        ? "No models configured; add one with /provider edit deepseek before testing."
        : "",
    )
    expect(session.calls).toEqual([])
    expect(session.asked).toHaveLength(stop === "no-models" ? 2 : stop === "model-escape" ? 3 : 4)
  }
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
  expect(fetched.message).toBe("2 models listed · models.dev details for 1.")
  expect(fetched.options?.models).toEqual([
    { value: "deepseek-chat", detail: ["128K", "$0.27/$1.1"] },
    { value: "deepseek-new" },
  ])
  const tested = await ext.ui.runFormAction(id, "testConnection", {})
  expect(tested).toEqual({
    message: "No model selected. Add a model to test, or save without a connection test.",
    tone: "warning",
  })
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
      if (r.title.includes("potentially billed")) return "Yes"
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
  expect(calls).toEqual(["list https://api.deepseek.com key=typed", "test deepseek-chat", "save ds-test"])
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
  expect(seen!.title).toBe("Edit provider · deepseek")
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

test("after saving, the manage page highlights the provider and opens its filtered model picker", async () => {
  const session = await setup(
    (r) => {
      if (r.kind === "form") return { baseUrl: "https://api.deepseek.com/v1" }
      if (r.kind !== "select") return undefined
      if (r.title === "Providers") return "deepseek"
      if (r.title.startsWith("Manage")) return "Use a model from it"
      if (r.title === "Model from deepseek") return r.options[1]
      return undefined
    },
    { afterSave: true },
  )
  expect((await session.run("/provider edit deepseek")).ok).toBe(true)
  expect(session.asked[1]).toMatchObject({ title: "Providers", initial: "deepseek" })
  expect(session.asked[3]).toMatchObject({
    title: "Model from deepseek",
    options: ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"],
  })
  expect(session.selectedModels).toEqual(["deepseek/deepseek-reasoner"])
})
