// Tooling-only preload. Every product HTTP request must target this session's fake provider.
// This is a belt-and-braces guard, not a sandbox for untrusted TS fixtures/extensions.
const origin = process.env.UI_WALK_PROVIDER_ORIGIN
if (!origin || !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error("Missing UI walk provider origin")
const originalFetch = globalThis.fetch
const guarded: typeof fetch = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
    if (url.origin !== origin) throw new Error(`UI walk blocked outbound request: ${url.origin}`)
    // Redirects cannot silently escape the allowed local origin.
    const response = await originalFetch(input, { ...init, redirect: "manual" })
    if (response.status >= 300 && response.status < 400) throw new Error("UI walk blocked HTTP redirect")
    return response
  },
  { preconnect: () => {} },
)
globalThis.fetch = guarded
