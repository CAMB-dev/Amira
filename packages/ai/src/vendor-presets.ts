import type { CatalogVendor } from "./catalog.ts"

const NPM_PROTOCOL: Record<string, string> = {
  "@ai-sdk/openai": "openai-responses",
  "@ai-sdk/openai-compatible": "openai-chat",
  "@openrouter/ai-sdk-provider": "openai-chat",
  "@ai-sdk/anthropic": "anthropic-messages",
  "@ai-sdk/google": "google-gemini",
}

const PROTOCOL_DEFAULTS: Record<string, { baseUrl?: string; rootPath?: string }> = {
  "openai-chat": {},
  "openai-responses": { baseUrl: "https://api.openai.com/v1", rootPath: "/v1" },
  "anthropic-messages": { baseUrl: "https://api.anthropic.com" },
  "google-gemini": { baseUrl: "https://generativelanguage.googleapis.com/v1beta", rootPath: "/v1beta" },
}

/** A supported catalog vendor's protocol and endpoint; never guesses from a vendor id. */
export function vendorPreset(vendor: CatalogVendor): { dialect: string; baseUrl: string } | undefined {
  const dialect = Object.hasOwn(NPM_PROTOCOL, vendor.npm) ? NPM_PROTOCOL[vendor.npm] : undefined
  if (!dialect) return undefined
  const defaults = PROTOCOL_DEFAULTS[dialect]!
  const api = vendor.api?.trim() || defaults.baseUrl
  if (!api) return undefined
  const base = api.replace(/\/+$/, "")
  // Catalog placeholders are editable prefills, not environment variable lookups.
  if (base.includes("${")) return { dialect, baseUrl: base }
  let url: URL
  try {
    url = new URL(base)
  } catch {
    return undefined
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.search || url.hash) return undefined
  // Native OpenAI and Gemini roots need a version; Anthropic adds /v1 itself.
  // Compatible endpoints use exactly the supplied path (some serve chat at the root).
  // An explicit path, including /v1, /v1beta, or a proxy prefix, is kept.
  const baseUrl = defaults.rootPath && url.pathname === "/" ? `${base}${defaults.rootPath}` : base
  return { dialect, baseUrl }
}
