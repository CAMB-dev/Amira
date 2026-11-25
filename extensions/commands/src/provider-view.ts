import {
  DIALECT_NOTES,
  type ProviderAdmin,
  type ProviderDraft,
  type ProviderVendor,
  type SessionControl,
  type UiControl,
  type UiEvent,
  type UiNode,
  type UiTreeItem,
  type ViewDefinition,
  type ViewLine,
  type ViewSegment,
  type ViewTextTone,
} from "@amira/api"
import type { ProviderConnectionTests } from "./provider-tests.ts"

export const ADD_PROVIDER_KEY = "__add__"

export type ProviderHubAction =
  | { kind: "add"; choice?: string }
  | { kind: "edit"; id: string }
  | { kind: "key"; id: string }
  | { kind: "test"; id: string }
  | { kind: "use"; id: string }
  | { kind: "remove"; id: string }
  | { kind: "close" }

export interface ProviderHubData {
  sessionId: string
  highlight?: string
  session: SessionControl
  admin: ProviderAdmin
  tests: ProviderConnectionTests
  vendors?: ProviderVendor[]
  vendorsLoading?: boolean
  onAction: (action: ProviderHubAction) => void
}

const LIST_ID = "providers.list"
const VENDOR_FILTER_ID = "providers.vendorFilter"
const VENDOR_LIST_ID = "providers.vendors"
const BTN_ADD = "providers.add"
const BTN_ADD_SELECTED_VENDOR = "providers.add.vendor"
const BTN_CUSTOM = "providers.add.custom"
const BTN_USE = "providers.use"
const BTN_EDIT = "providers.edit"
const BTN_KEY = "providers.key"
const BTN_TEST = "providers.test"
const BTN_REMOVE = "providers.remove"
const BTN_CLOSE = "providers.close"

const POPULAR_ROW_1 = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai", label: "OpenAI" },
  { id: "google", label: "Google" },
  { id: "deepseek", label: "DeepSeek" },
] as const

const POPULAR_ROW_2 = [
  { id: "openrouter", label: "OpenRouter" },
  { id: "groq", label: "Groq" },
  { id: "mistral", label: "Mistral" },
  { id: "xai", label: "xAI" },
] as const

const PROTOCOL_BUTTONS = [
  { id: "openai-chat", label: "OpenAI-Compat" },
  { id: "openai-responses", label: "Responses" },
  { id: "anthropic-messages", label: "Anthropic API" },
  { id: "google-gemini", label: "Gemini API" },
] as const

const POPULAR_IDS = new Set<string>([...POPULAR_ROW_1, ...POPULAR_ROW_2].map((v) => v.id))

const seg = (text: string, kind: ViewTextTone = "text"): ViewSegment => ({ kind, text })
const chip = (
  text: string,
  tone: "neutral" | "info" | "success" | "warning" | "danger" | "accent" = "neutral",
): ViewSegment => ({ kind: "chip", text, tone })
const row = (...parts: ViewSegment[]): ViewLine => ({ kind: "segments", parts })

function keySummary(
  provider: ReturnType<SessionControl["providers"]>[number],
  draft: ProviderDraft | undefined,
  admin: ProviderAdmin,
): { text: string; tone: ViewTextTone } {
  const source = draft?.keySource ?? (provider.apiKeyEnv ? "env" : "none")
  if (source === "none") return { text: "none (not required)", tone: "muted" }
  if (source === "auth") {
    const hint = admin.storedKeyHint(provider.id)
    if (provider.hasKey) return { text: `auth.json${hint ? ` (${hint})` : ""} · ready`, tone: "success" }
    return { text: "auth.json · missing key", tone: "warning" }
  }
  const variable = draft?.apiKeyEnv ?? provider.apiKeyEnv
  const label = variable ? `env (${variable})` : "env"
  return provider.hasKey
    ? { text: `${label} · set`, tone: "success" }
    : { text: `${label} · missing`, tone: "warning" }
}

function formatTokens(n: number | undefined): string {
  if (!n) return ""
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function buildAddStudio(
  data: ProviderHubData,
  filterQuery: string,
  selectedVendorId: string | undefined,
): UiNode {
  const dialects = new Set(data.admin.dialects())
  const availableProtocols = PROTOCOL_BUTTONS.filter((p) => dialects.has(p.id))
  const vendors = data.vendors ?? data.admin.cachedVendors?.() ?? []
  const q = filterQuery.trim().toLowerCase()
  const filteredVendors = vendors
    .filter((v) => !q || v.id.toLowerCase().includes(q) || v.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const ap = POPULAR_IDS.has(a.id) ? 0 : 1
      const bp = POPULAR_IDS.has(b.id) ? 0 : 1
      return ap - bp || a.name.localeCompare(b.name)
    })

  const vendorItems: UiTreeItem[] = filteredVendors.slice(0, 40).map((v) => ({
    key: v.id,
    row: [seg(v.name, "text"), seg(` (${v.id})`, "muted")],
    aside: [seg(v.dialect ?? "pick protocol", v.dialect ? "muted" : "warning")],
  }))
  const pickedVendor = filteredVendors.find((v) => v.id === selectedVendorId) ?? filteredVendors[0]

  const buttonRow = (items: readonly { id: string; label: string }[], prefix: string): UiNode => ({
    type: "row",
    gap: 1,
    children: items.map((item) => ({
      size: Math.max(10, item.label.length + 5),
      node: {
        type: "button" as const,
        id: `${prefix}:${item.id}`,
        key: item.id,
        label: item.label,
      },
    })),
  })

  const catalogBlock: UiNode = data.vendorsLoading
    ? {
        type: "text",
        lines: [
          row({ kind: "spinner", tone: "accent" }, seg(" Loading vendor catalog from models.dev…", "muted")),
        ],
      }
    : vendorItems.length
      ? { type: "tree", id: VENDOR_LIST_ID, items: vendorItems }
      : {
          type: "text",
          lines: [
            {
              kind: "muted",
              text: q
                ? `No catalog vendor matches "${filterQuery.trim()}". Use a protocol button above or Custom form.`
                : "Catalog unavailable offline — pick a protocol button above or open Custom form.",
            },
          ],
        }

  const filterChildren: { node: UiNode; size?: number }[] = [
    {
      node: {
        type: "input",
        id: VENDOR_FILTER_ID,
        activate: "/",
        placeholder: "Filter vendors (e.g. kimi, qwen, ollama, together)…",
      },
    },
  ]
  if (pickedVendor) {
    const label = `Add ${pickedVendor.id}`
    filterChildren.push({
      size: Math.min(24, Math.max(12, label.length + 5)),
      node: {
        type: "button",
        id: BTN_ADD_SELECTED_VENDOR,
        key: pickedVendor.id,
        label,
        tone: "accent",
      },
    })
  }

  return {
    type: "box",
    title: "Add provider",
    aside: vendors.length ? `${filteredVendors.length}/${vendors.length} vendors` : "quick setup",
    border: "round",
    tone: "accent",
    child: {
      type: "column",
      gap: 1,
      children: [
        {
          size: 1,
          node: {
            type: "text",
            lines: [
              {
                kind: "muted",
                text: "Pick a vendor, protocol, or filter the catalog below to add a provider.",
              },
            ],
          },
        },
        { size: 1, node: { type: "rule", label: "Popular vendors" } },
        { size: 1, node: buttonRow(POPULAR_ROW_1, "vendor") },
        { size: 1, node: buttonRow(POPULAR_ROW_2, "vendor") },
        { size: 1, node: { type: "rule", label: "Custom / local protocols" } },
        {
          size: 1,
          node: {
            type: "row",
            gap: 1,
            children: [
              ...availableProtocols.map((p) => ({
                size: Math.max(12, p.label.length + 5),
                node: { type: "button" as const, id: `protocol:${p.id}`, key: p.id, label: p.label },
              })),
              {
                size: 18,
                node: {
                  type: "button" as const,
                  id: BTN_CUSTOM,
                  label: "Custom form",
                  tone: "accent" as const,
                },
              },
            ],
          },
        },
        { size: 1, node: { type: "rule", label: "Search catalog (/ to filter)" } },
        {
          size: 1,
          node: {
            type: "row",
            gap: 1,
            children: filterChildren,
          },
        },
        { node: catalogBlock },
      ],
    },
  }
}

function buildDetailCard(
  data: ProviderHubData,
  selectedKey: string,
  filterQuery: string,
  selectedVendorId: string | undefined,
): UiNode {
  const providers = data.session.providers()
  if (selectedKey === ADD_PROVIDER_KEY || !providers.length) {
    return buildAddStudio(data, filterQuery, selectedVendorId)
  }
  const provider = providers.find((p) => p.id === selectedKey) ?? providers[0]!

  const current = data.session.info().model
  const isCurrent = current.provider === provider.id
  const draft = data.admin.draft(provider.id)
  const keyInfo = keySummary(provider, draft, data.admin)
  const testStatus = data.tests.status(data.sessionId, data.admin, provider.id)
  const dialectNote = DIALECT_NOTES[provider.dialect]
  const models = draft?.models ?? []
  const described = models.length && draft ? data.admin.describeModels(draft, models) : []

  const detailLines: ViewLine[] = [
    row(
      seg("Status    ", "muted"),
      isCurrent ? chip(`active · ${current.model}`, "accent") : chip("configured", "neutral"),
    ),
    row(
      seg("Protocol  ", "muted"),
      seg(provider.dialect || "(none)", "text"),
      ...(dialectNote ? [seg(` · ${dialectNote}`, "muted")] : []),
    ),
    row(
      seg("Endpoint  ", "muted"),
      seg(provider.baseUrl || "(no base URL)", provider.baseUrl ? "text" : "muted"),
    ),
    row(seg("API key   ", "muted"), seg(keyInfo.text, keyInfo.tone)),
    row(
      seg("Test      ", "muted"),
      testStatus
        ? chip(testStatus, testStatus.includes("passed") ? "success" : "danger")
        : seg("not tested this session", "muted"),
    ),
  ]

  const modelLines: ViewLine[] = described.length
    ? described.slice(0, 14).map((m) => {
        const activeModel = isCurrent && current.model === m.id
        const ctx = formatTokens(m.contextWindow)
        const price = m.inCatalog && m.cost ? `$${m.cost.input}/$${m.cost.output}` : ""
        const meta = [ctx ? `${ctx} ctx` : "", price].filter(Boolean).join(" · ")
        return row(
          activeModel ? seg(`● ${m.id}`, "accent") : seg(`  ${m.id}`, "text"),
          ...(meta ? [seg(`  ${meta}`, "muted")] : []),
        )
      })
    : [{ kind: "muted", text: "No models configured yet — click Edit to fetch or add models." }]
  if (described.length > 14) {
    modelLines.push({ kind: "muted", text: `  … and ${described.length - 14} more models` })
  }

  return {
    type: "box",
    title: isCurrent ? `${provider.id} · active` : provider.id,
    aside: `${models.length} ${models.length === 1 ? "model" : "models"}`,
    border: "round",
    tone: isCurrent ? "accent" : "normal",
    child: {
      type: "column",
      gap: 1,
      children: [
        { size: detailLines.length, node: { type: "text", lines: detailLines } },
        { size: 1, node: { type: "rule", label: "Actions" } },
        {
          size: 1,
          node: {
            type: "row",
            gap: 1,
            children: [
              { size: 15, node: { type: "button", id: BTN_USE, label: "Use model", tone: "accent" } },
              { size: 10, node: { type: "button", id: BTN_EDIT, label: "Edit" } },
              { size: 13, node: { type: "button", id: BTN_KEY, label: "Set key" } },
              { size: 10, node: { type: "button", id: BTN_TEST, label: "Test" } },
              { size: 12, node: { type: "button", id: BTN_REMOVE, label: "Remove" } },
            ],
          },
        },
        { size: 1, node: { type: "rule", label: `Models (${models.length})` } },
        { node: { type: "text", id: "providers.models", lines: modelLines } },
      ],
    },
  }
}

function buildListCard(data: ProviderHubData): UiNode {
  const providers = data.session.providers()
  const current = data.session.info().model.provider
  const items: UiTreeItem[] = [
    {
      key: ADD_PROVIDER_KEY,
      row: [seg("+ ", "accent"), seg("Add provider", "accent")],
      aside: [seg("new", "muted")],
    },
    ...providers.map((p): UiTreeItem => {
      const draft = data.admin.draft(p.id)
      const count = draft?.models.length ?? 0
      const active = p.id === current
      const source = draft?.keySource ?? (p.apiKeyEnv ? "env" : "none")
      const keyMissing = !p.hasKey && source !== "none"
      const status = data.tests.status(data.sessionId, data.admin, p.id)
      const statusBadge = status?.includes("passed") ? " ✓" : status?.includes("failed") ? " ✗" : ""
      return {
        key: p.id,
        row: [seg(active ? "● " : "○ ", active ? "accent" : "muted"), seg(p.id, active ? "accent" : "text")],
        aside: [
          seg(
            `${count}m${keyMissing ? " !key" : ""}${statusBadge}`,
            keyMissing ? "warning" : status?.includes("failed") ? "error" : "muted",
          ),
        ],
      }
    }),
  ]

  return {
    type: "box",
    title: "Providers",
    aside: `${providers.length}`,
    border: "round",
    tone: "focus",
    child: { type: "tree", id: LIST_ID, items },
  }
}

/** Unified split-pane GUI provider hub: browse/manage configured providers AND add new ones in one page. */
export function providerView(): ViewDefinition<ProviderHubData> {
  // Always deliver the chosen action BEFORE control.close(), because close() synchronously triggers
  // onClose() -> onAction({ kind: "close" }); settling the real action first prevents close from winning.
  const dispatch = (data: ProviderHubData, control: UiControl, action: ProviderHubAction) => {
    data.onAction(action)
    control.close()
  }

  return {
    kind: "providers",
    needsTab: true,
    title: (data) => `Providers (${data.session.providers().length})`,
    keys: [
      { key: "a", label: "add" },
      { key: "e", label: "edit" },
      { key: "u", label: "use model" },
      { key: "k", label: "set key" },
      { key: "t", label: "test" },
      { key: "d", label: "remove" },
    ],
    onOpen: (data, control) => {
      if (data.vendors || data.admin.cachedVendors?.()?.length || !data.admin.vendors) return
      data.vendorsLoading = true
      control.requestRender()
      void data.admin
        .vendors()
        .then((list) => {
          data.vendors = list
          data.vendorsLoading = false
          control.requestRender()
        })
        .catch(() => {
          data.vendorsLoading = false
          control.requestRender()
        })
    },
    ui: (data, ctx) => {
      const providers = data.session.providers()
      const current = data.session.info().model
      const validSelection = (key: string | undefined) =>
        key === ADD_PROVIDER_KEY || (key !== undefined && providers.some((p) => p.id === key))
      const selectedKey =
        (validSelection(ctx.state.selected[LIST_ID]) ? ctx.state.selected[LIST_ID] : undefined) ??
        (validSelection(data.highlight) ? data.highlight : undefined) ??
        (providers.some((p) => p.id === current.provider) ? current.provider : providers[0]?.id) ??
        ADD_PROVIDER_KEY
      const filterQuery = ctx.state.inputValues[VENDOR_FILTER_ID] ?? ""
      const selectedVendorId = ctx.state.selected[VENDOR_LIST_ID]

      const toolbarChildren: { node: UiNode; size?: number }[] = [
        {
          node: {
            type: "bar",
            left: [
              seg(`${providers.length} ${providers.length === 1 ? "provider" : "providers"}`, "text"),
              ...(current.provider
                ? [seg(" · active: ", "muted"), seg(`${current.provider}/${current.model}`, "accent")]
                : [seg(" · no model active", "muted")]),
            ],
          },
        },
        {
          size: 18,
          node: {
            type: "button",
            id: BTN_ADD,
            label: "+ Add provider",
            tone: selectedKey === ADD_PROVIDER_KEY ? "normal" : "accent",
          },
        },
        { size: 9, node: { type: "button", id: BTN_CLOSE, label: "Close" } },
      ]

      const body: UiNode =
        ctx.width >= 84
          ? {
              type: "row",
              gap: 1,
              children: [
                { size: "30%", min: 22, node: buildListCard(data) },
                { node: buildDetailCard(data, selectedKey, filterQuery, selectedVendorId) },
              ],
            }
          : {
              type: "column",
              gap: 1,
              children: [
                { size: Math.min(8, Math.max(4, providers.length + 3)), node: buildListCard(data) },
                { node: buildDetailCard(data, selectedKey, filterQuery, selectedVendorId) },
              ],
            }

      return {
        type: "column",
        gap: 1,
        children: [{ size: 1, node: { type: "row", gap: 2, children: toolbarChildren } }, { node: body }],
      }
    },
    onEvent: (event: UiEvent, data, control) => {
      const providers = data.session.providers()
      const switchToAdd = () => {
        data.highlight = ADD_PROVIDER_KEY
        control.setState({ selected: { [LIST_ID]: ADD_PROVIDER_KEY } })
        control.requestRender()
      }

      if (event.type === "select" && event.id === LIST_ID) {
        data.highlight = event.key
        control.requestRender()
        return
      }

      const fallback =
        (data.highlight === ADD_PROVIDER_KEY ||
        (data.highlight && providers.some((p) => p.id === data.highlight))
          ? data.highlight
          : undefined) ??
        providers.find((p) => p.id === data.session.info().model.provider)?.id ??
        providers[0]?.id
      const activeId = fallback && fallback !== ADD_PROVIDER_KEY ? fallback : undefined

      if (event.type === "activate") {
        if (event.id === LIST_ID) {
          if (event.key === ADD_PROVIDER_KEY) return switchToAdd()
          return dispatch(data, control, { kind: "edit", id: event.key })
        }
        if (event.id === BTN_ADD) return switchToAdd()
        if (event.id === BTN_CUSTOM) return dispatch(data, control, { kind: "add" })
        if (event.id === BTN_CLOSE) return dispatch(data, control, { kind: "close" })
        if (
          event.id.startsWith("vendor:") ||
          event.id.startsWith("protocol:") ||
          event.id === VENDOR_LIST_ID ||
          event.id === BTN_ADD_SELECTED_VENDOR
        ) {
          return dispatch(data, control, { kind: "add", choice: event.key })
        }
        if (!activeId) return
        if (event.id === BTN_USE) return dispatch(data, control, { kind: "use", id: activeId })
        if (event.id === BTN_EDIT) return dispatch(data, control, { kind: "edit", id: activeId })
        if (event.id === BTN_KEY) return dispatch(data, control, { kind: "key", id: activeId })
        if (event.id === BTN_TEST) return dispatch(data, control, { kind: "test", id: activeId })
        if (event.id === BTN_REMOVE) return dispatch(data, control, { kind: "remove", id: activeId })
        return
      }
      if (event.type === "key") {
        if (event.key === "a") return switchToAdd()
        if (!activeId) return
        if (event.key === "e") return dispatch(data, control, { kind: "edit", id: activeId })
        if (event.key === "u") return dispatch(data, control, { kind: "use", id: activeId })
        if (event.key === "k") return dispatch(data, control, { kind: "key", id: activeId })
        if (event.key === "t") return dispatch(data, control, { kind: "test", id: activeId })
        if (event.key === "d") return dispatch(data, control, { kind: "remove", id: activeId })
      }
    },
    onClose: (data) => {
      data.onAction({ kind: "close" })
    },
  }
}
