import type { ProviderAdmin, ProviderDraft } from "@amira/api"

/** Blank secrets keep the configured key; typed replacements are trimmed before use. */
function normalizedDraft(draft: ProviderDraft): ProviderDraft {
  const { apiKey, ...rest } = draft
  const key = apiKey?.trim()
  return key ? { ...rest, apiKey: key } : rest
}

/** Only non-secret configuration participates in the page's session-local test status. */
function configuration(draft: ProviderDraft, keyHint: string | undefined): string | undefined {
  if (draft.apiKey?.trim()) return undefined // A typed key is an unsaved credential.
  const defaults = draft.defaults
  return JSON.stringify([
    draft.id,
    draft.catalogId ?? draft.id,
    draft.dialect,
    draft.baseUrl.trim().replace(/\/+$/, ""),
    draft.keySource,
    draft.keySource === "env" ? draft.apiKeyEnv : undefined,
    draft.models,
    defaults?.contextWindow,
    defaults?.maxOutput,
    defaults?.thinking ?? false,
    defaults?.images ?? false,
    defaults?.promptCache ?? false,
    keyHint,
  ])
}

/** One recorder shared by menu and form tests; unsaved drafts cannot relabel a saved provider. */
export class ProviderConnectionTests {
  private results = new Map<string, { configuration: string; status: string }>()
  private revisions = new Map<string, number>()

  status(sessionId: string, admin: ProviderAdmin, id: string): string | undefined {
    const draft = admin.draft(id)
    const recorded = this.results.get(`${sessionId}/${id}`)
    return draft && recorded?.configuration === configuration(draft, admin.storedKeyHint(id))
      ? recorded?.status
      : undefined
  }

  wrap(sessionId: string, admin: ProviderAdmin): ProviderAdmin {
    const record = (
      id: string,
      revision: number,
      tested: string | undefined,
      model: string,
      status: string,
    ) => {
      const current = admin.draft(id)
      if (
        (this.revisions.get(id) ?? 0) === revision &&
        current &&
        tested !== undefined &&
        tested === configuration(current, admin.storedKeyHint(id))
      ) {
        this.results.set(`${sessionId}/${id}`, {
          configuration: tested,
          status: `test: ${status} (${model})`,
        })
      }
    }
    return {
      ...admin,
      test: async (draft, model, signal) => {
        const normalized = normalizedDraft(draft)
        // Keep the pre-request configuration: a concurrent save must not relabel the result.
        const tested = configuration(normalized, admin.storedKeyHint(draft.id))
        const revision = this.revisions.get(draft.id) ?? 0
        try {
          const result = await admin.test(normalized, model, signal)
          signal?.throwIfAborted()
          record(
            draft.id,
            revision,
            tested,
            `${model}, ${result.latencyMs} ms`,
            result.ok ? "passed" : "failed",
          )
          return result
        } catch (error) {
          signal?.throwIfAborted()
          record(draft.id, revision, tested, model, "failed")
          throw error
        }
      },
      save: async (draft) => {
        const normalized = normalizedDraft(draft)
        const result = await admin.save(normalized)
        if (normalized.apiKey) this.invalidate(draft.id)
        return result
      },
      setKey: async (id, key) => {
        const result = await admin.setKey(id, key)
        this.invalidate(id)
        return result
      },
      remove: async (id, opts) => {
        const result = await admin.remove(id, opts)
        this.invalidate(id)
        return result
      },
    }
  }

  private invalidate(id: string): void {
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1)
    for (const key of this.results.keys()) if (key.endsWith(`/${id}`)) this.results.delete(key)
  }
}
