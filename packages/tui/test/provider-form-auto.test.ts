import { expect, test } from "bun:test"
import {
  type FormSpec,
  isFieldVisible,
  type ProviderAdmin,
  type ProviderDraft,
  type ProviderFormInitial,
  type ProviderModelInfo,
  providerFormSpec,
} from "@amira/api"
import { EventBus, UiRequests } from "@amira/core"
import { key, textKey } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { FormView, specFormBackend, uiFormBackend } from "../src/form-view.ts"

const MODELS: ProviderModelInfo[] = [{ id: "served-model", inCatalog: true, contextWindow: 64000 }]
const INITIAL: ProviderFormInitial = {
  id: "test",
  dialect: "openai-chat",
  baseUrl: "https://provider.example/v1",
  keySource: "none",
}

function setup(
  opts: {
    hosted?: boolean
    initial?: ProviderFormInitial
    existing?: ProviderDraft
    admin?: Partial<ProviderAdmin>
  } = {},
) {
  const calls: { draft: ProviderDraft; signal?: AbortSignal }[] = []
  const admin: ProviderAdmin = {
    dialects: () => ["openai-chat", "anthropic-messages"],
    exists: () => false,
    draft: () => undefined,
    storedKeyHint: () => undefined,
    envIsSet: () => false,
    listModels: async () => MODELS,
    describeModels: (_draft, ids) => ids.map((id) => ({ id, inCatalog: false })),
    test: async () => ({ ok: true, latencyMs: 1, message: "OK" }),
    save: async () => "Saved",
    remove: async () => "Removed",
    setKey: async () => "Stored",
    ...opts.admin,
  }
  const list = admin.listModels
  admin.listModels = async (draft, signal) => {
    calls.push({ draft, ...(signal ? { signal } : {}) })
    return list(draft, signal)
  }
  const spec = providerFormSpec(admin, opts.existing, { ...INITIAL, ...opts.initial })
  const ui = new UiRequests(new EventBus())
  let saved: unknown
  let answer: Promise<unknown> | undefined
  if (opts.hosted) answer = ui.form(spec)
  const request = ui.pending[0]
  if (opts.hosted && request?.kind !== "form") throw new Error("expected a form request")
  const backend =
    opts.hosted && request?.kind === "form"
      ? uiFormBackend(ui, request)
      : specFormBackend(spec, (values) => {
          saved = values
        })
  let renders = 0
  const view = new FormView(backend, { requestRender: () => renders++, onClose: () => {} })
  const screen = () => view.render(120, { ...plain, rows: 100 }).join("\n")
  const focus = (id: string) => {
    const ids = spec.fields.filter((f) => isFieldVisible(spec, f, view.form.values)).map((f) => f.id)
    for (let i = 0; i < ids.length + 2 && view.form.focused !== id; i++) {
      const before = ids.indexOf(view.form.focused)
      view.handleInput(key("tab", { shift: before < 0 || before > ids.indexOf(id) }))
    }
    expect(view.form.focused).toBe(id)
  }
  const type = (text: string) => {
    for (const ch of text) view.handleInput(textKey(ch))
  }
  return {
    calls,
    view,
    screen,
    focus,
    type,
    saved: () => saved,
    renders: () => renders,
    close: async () => {
      view.close()
      ui.cancelAll()
      await answer
    },
  }
}

async function waitFor(check: () => boolean, what: string) {
  const deadline = performance.now() + 3000
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(5)
  }
}

const tick = () => Bun.sleep(0)

test("standalone readiness uses fetched option overrides and does not restore invalid defaults", async () => {
  const spec: FormSpec = {
    title: "options",
    fields: [
      { type: "number", id: "count", label: "Count", default: 3 },
      { type: "select", id: "choice", label: "Choice", options: [{ value: "initial" }] },
      {
        type: "action",
        id: "load",
        label: "Load",
        auto: {
          watch: ["count", "choice"],
          ready: (values) => values.choice === "new" && Number(values.count) > 0,
        },
        run: async () => ({ options: { choice: [{ value: "new" }] } }),
      },
    ],
  }
  const backend = specFormBackend(spec, () => {})
  await backend.runAction("load", {}, { signal: new AbortController().signal, onProgress: () => {} })
  expect(backend.autoActions?.({ choice: "new" })).toEqual(["load"])
  expect(backend.autoActions?.({ choice: "new", count: "invalid" })).toEqual([])
})

test.each([false, true])(
  "complete provider inputs fetch once without a button (hosted: %s)",
  async (hosted) => {
    const form = setup({ hosted })
    try {
      await waitFor(() => form.screen().includes("The provider listed"), "automatic model list")
      expect(form.calls).toHaveLength(1)
      form.focus("models")
      expect(form.screen()).toContain("served-model")
      expect(form.screen()).toContain("models.dev")
      expect(form.renders()).toBeGreaterThan(0)
      form.view.handleInput(key("tab"))
      await tick()
      expect(form.calls).toHaveLength(1)
    } finally {
      await form.close()
    }
  },
)

test("a typed auth key fetches only after leaving the key field; changing the URL refetches", async () => {
  const form = setup({ initial: { keySource: "auth" } })
  try {
    await tick()
    expect(form.calls).toEqual([])
    form.focus("apiKey")
    form.type("sk-fake-secret")
    await tick()
    expect(form.calls).toEqual([])
    expect(form.screen()).not.toContain("sk-fake-secret")
    form.view.handleInput(key("tab"))
    await waitFor(() => form.calls.length === 1, "confirmed key fetch")
    expect(form.calls[0]?.draft.apiKey).toBe("sk-fake-secret")
    await waitFor(() => form.screen().includes("The provider listed"), "first result")
    form.focus("baseUrl")
    form.view.handleInput(key("u", { ctrl: true }))
    form.type("https://other.example/v1")
    await tick()
    expect(form.calls).toHaveLength(1)
    form.view.handleInput(key("tab"))
    await waitFor(() => form.calls.length === 2, "new URL fetch")
    expect(form.calls[1]?.draft.baseUrl).toBe("https://other.example/v1")
    await waitFor(() => form.screen().includes("The provider listed"), "second result")
    form.focus("apiKey")
    form.view.handleInput(key("u", { ctrl: true }))
    form.type("sk-new-fake")
    await tick()
    expect(form.calls).toHaveLength(2)
    form.view.handleInput(key("tab"))
    await waitFor(() => form.calls.length === 3, "changed key fetch")
    expect(form.calls[2]?.draft.apiKey).toBe("sk-new-fake")
    await waitFor(() => form.screen().includes("The provider listed"), "third result")
    form.focus("id")
    form.view.handleInput(key("u", { ctrl: true }))
    form.type("renamed")
    form.view.handleInput(key("tab"))
    await tick()
    expect(form.calls).toHaveLength(3)
  } finally {
    await form.close()
  }
})

test.each(["auth", "env"] as const)("missing %s credentials do not fetch", async (keySource) => {
  const form = setup({ initial: { keySource, apiKeyEnv: "UNSET_KEY" } })
  try {
    await tick()
    form.focus("models")
    await tick()
    expect(form.calls).toEqual([])
  } finally {
    await form.close()
  }
})

test.each(["auth", "env"] as const)("existing %s credentials allow an automatic fetch", async (keySource) => {
  const form = setup({
    initial: { keySource, apiKeyEnv: "SET_KEY" },
    admin: { storedKeyHint: () => "(set)", envIsSet: (name) => name === "SET_KEY" },
  })
  try {
    await waitFor(() => form.calls.length === 1, "available credentials")
    expect(form.calls[0]?.draft.keySource).toBe(keySource)
  } finally {
    await form.close()
  }
})

test.each([false, true])(
  "a stale fetch is aborted and settled before refetching (hosted: %s)",
  async (hosted) => {
    const pending: ReturnType<typeof Promise.withResolvers<ProviderModelInfo[]>>[] = []
    const form = setup({
      hosted,
      admin: {
        listModels: async () => {
          const next = Promise.withResolvers<ProviderModelInfo[]>()
          pending.push(next)
          return next.promise
        },
      },
    })
    try {
      await waitFor(() => pending.length === 1, "first pending request")
      expect(form.screen()).toContain("asking https://provider.example/v1")
      form.focus("baseUrl")
      form.view.handleInput(key("u", { ctrl: true }))
      form.type("https://new.example/v1")
      expect(form.calls[0]?.signal?.aborted).toBe(true)
      form.view.handleInput(key("tab"))
      await tick()
      expect(form.calls).toHaveLength(1)
      pending[0]!.resolve([{ id: "stale-model", inCatalog: false }])
      await waitFor(() => pending.length === 2, "replacement request")
      expect(form.calls[1]?.draft.baseUrl).toBe("https://new.example/v1")
      form.focus("models")
      expect(form.screen()).not.toContain("stale-model")
      pending[1]!.resolve([{ id: "new-model", inCatalog: false }])
      await waitFor(() => form.screen().includes("new-model"), "current results")
      expect(form.screen()).not.toContain("stale-model")
      expect(form.calls).toHaveLength(2)
    } finally {
      for (const p of pending) p.resolve([])
      await form.close()
    }
  },
)

test("restoring an edited URL restarts its interrupted fetch without overlap", async () => {
  const pending: ReturnType<typeof Promise.withResolvers<ProviderModelInfo[]>>[] = []
  const form = setup({
    admin: {
      listModels: async () => {
        const next = Promise.withResolvers<ProviderModelInfo[]>()
        pending.push(next)
        return next.promise
      },
    },
  })
  try {
    await waitFor(() => pending.length === 1, "initial request")
    form.focus("baseUrl")
    form.view.handleInput(key("backspace"))
    form.type("1")
    expect(form.calls[0]?.signal?.aborted).toBe(true)
    await tick()
    expect(form.calls).toHaveLength(1)
    pending[0]!.resolve([{ id: "discarded", inCatalog: false }])
    await waitFor(() => pending.length === 2, "restored URL replacement")
    expect(form.calls[1]?.draft.baseUrl).toBe(INITIAL.baseUrl)
    pending[1]!.resolve(MODELS)
    await waitFor(() => form.screen().includes("The provider listed"), "replacement result")
    expect(form.calls).toHaveLength(2)
  } finally {
    for (const p of pending) p.resolve([])
    await form.close()
  }
})

test("changing the id holding a stored key aborts the old credential's request", async () => {
  const pending: ReturnType<typeof Promise.withResolvers<ProviderModelInfo[]>>[] = []
  const form = setup({
    initial: { id: "a", keySource: "auth" },
    admin: {
      storedKeyHint: (id) => (["a", "b"].includes(id) ? "(set)" : undefined),
      listModels: async () => {
        const next = Promise.withResolvers<ProviderModelInfo[]>()
        pending.push(next)
        return next.promise
      },
    },
  })
  try {
    await waitFor(() => pending.length === 1, "first credential request")
    form.focus("id")
    form.view.handleInput(key("u", { ctrl: true }))
    form.type("b")
    form.view.handleInput(key("tab"))
    expect(form.calls[0]?.signal?.aborted).toBe(true)
    expect(form.calls).toHaveLength(1)
    pending[0]!.resolve([{ id: "from-a", inCatalog: false }])
    await waitFor(() => pending.length === 2, "new stored credential request")
    expect(form.calls[1]?.draft.id).toBe("b")
    pending[1]!.resolve([{ id: "from-b", inCatalog: false }])
    form.focus("models")
    await waitFor(() => form.screen().includes("from-b"), "new credential results")
    expect(form.screen()).not.toContain("from-a")
  } finally {
    for (const p of pending) p.resolve([])
    await form.close()
  }
})

test.each(["none", "env"] as const)("renaming an id with %s auth does not refetch", async (keySource) => {
  const form = setup({ initial: { keySource, apiKeyEnv: "KEY" }, admin: { envIsSet: () => true } })
  try {
    await waitFor(() => form.screen().includes("The provider listed"), "first result")
    form.focus("id")
    form.view.handleInput(key("u", { ctrl: true }))
    form.type("renamed")
    form.view.handleInput(key("tab"))
    await tick()
    expect(form.calls).toHaveLength(1)
  } finally {
    await form.close()
  }
})

test("a failed automatic fetch appears once inline; custom models and manual refetch still work", async () => {
  let attempts = 0
  const form = setup({
    admin: {
      listModels: async () => {
        if (++attempts === 1) throw new Error("Provider unavailable; try again.")
        return MODELS
      },
    },
  })
  try {
    await waitFor(() => form.screen().includes("Provider unavailable; try again."), "inline failure")
    expect(form.view.closed).toBe(false)
    form.focus("models")
    form.type("custom-model")
    form.view.handleInput(key("enter"))
    await tick()
    expect(form.calls).toHaveLength(1)
    expect(form.view.form.values.models).toEqual(["custom-model"])
    form.focus("fetchModels")
    form.view.handleInput(key("enter"))
    await waitFor(() => form.screen().includes("The provider listed"), "manual retry")
    expect(form.calls).toHaveLength(2)
    expect(form.view.form.values.models).toEqual(["custom-model"])
    form.view.handleInput(key("s", { ctrl: true }))
    expect(form.saved()).toMatchObject({ models: ["custom-model"] })
  } finally {
    await form.close()
  }
})

test.each([false, true])(
  "edit auto-fetches only when the original model list is empty (empty: %s)",
  async (empty) => {
    const form = setup({
      existing: {
        id: "test",
        dialect: "openai-chat",
        baseUrl: "https://provider.example/v1",
        keySource: "none",
        models: empty ? [] : ["configured-model"],
      },
    })
    try {
      if (empty) await waitFor(() => form.calls.length === 1, "empty edit model list")
      else {
        await tick()
        expect(form.calls).toEqual([])
      }
    } finally {
      await form.close()
    }
  },
)
