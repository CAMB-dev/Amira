import { isNoModel } from "@amira/ai"
import type { SessionControl } from "@amira/api"
import { createExtensionAdmin } from "@amira/packages"
import { createProviderAdmin } from "../provider-admin.ts"
import type { ControlContext } from "./context.ts"

type AdminControl = Pick<
  SessionControl,
  "providers" | "extensionAdmin" | "providerAdmin" | "reloadExtensions"
>

export function createAdminControl(ctx: ControlContext): AdminControl {
  return {
    providers: () =>
      ctx.ai.providers().map((p) => ({
        id: p.id,
        dialect: p.dialect,
        baseUrl: p.baseUrl,
        ...(p.apiKeyEnv ? { apiKeyEnv: p.apiKeyEnv } : {}),
        hasKey: ctx.ai.hasKey(p.id),
      })),
    extensionAdmin: createExtensionAdmin({ cwd: ctx.cwd, ...(ctx.home ? { home: ctx.home } : {}) }),
    providerAdmin: createProviderAdmin({
      ai: ctx.ai,
      ...(ctx.home ? { home: ctx.home } : {}),
      platform: ctx.platform,
      currentProvider: () => ctx.agent().model.provider,
      // A first provider is used at once, and an edit of the one in use applies at once:
      // neither needs /model. Not during a turn; /model does it then.
      onSaved: (id, models) => {
        const a = ctx.agent()
        if (a.busy) return undefined
        const m = a.model
        const ref = isNoModel(m)
          ? models[0] && `${id}/${models[0]}`
          : m.provider === id
            ? `${id}/${models.length && !models.includes(m.id) ? models[0] : m.id}`
            : undefined
        if (!ref) return undefined
        try {
          a.setModel(ctx.ai.model(ref))
          return ref
        } catch {
          return undefined
        }
      },
    }),
    reloadExtensions: async () => {
      // Unloading drops tools and MCP connections a running tool call may still be using.
      ctx.idle("reload extensions")
      // Held like a compaction: a prompt or notice meanwhile would reach the model with the
      // tools half loaded, so it waits for the reload and starts its turn after.
      const a = ctx.agent()
      return a.hold("reload", () => ctx.session.reload(a))
    },
  }
}
