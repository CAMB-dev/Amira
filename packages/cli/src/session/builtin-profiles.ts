import type { Extension } from "@amira/api"

/** Extensions bundled with Amira and loaded by default (D50). */
export async function defaultBuiltins(): Promise<{ source: string; extension: Extension }[]> {
  const bundled: [string, () => Promise<{ default?: unknown }>][] = [
    ["builtin:tools", () => import("../../../../extensions/builtin-tools/src/index.ts")],
    [
      "builtin:tool-search",
      async () => ({
        default: (await import("../../../../extensions/builtin-tools/src/tool-search.ts"))
          .toolSearchExtension,
      }),
    ],
    ["builtin:status", () => import("../../../../extensions/status/src/index.ts")],
    ["builtin:terminal-status", () => import("../../../../extensions/terminal-status/src/index.ts")],
    ["builtin:commands", () => import("../../../../extensions/commands/src/index.ts")],
    ["builtin:auto-title", () => import("../../../../extensions/auto-title/src/index.ts")],
    ["builtin:skills", () => import("../../../../extensions/skills/src/index.ts")],
    ["builtin:mcp", () => import("../../../../extensions/mcp/src/index.ts")],
    ["builtin:web", () => import("../../../../extensions/web/src/index.ts")],
    ["builtin:agent", () => import("../../../../extensions/agent/src/index.ts")],
  ]
  const out: { source: string; extension: Extension }[] = []
  for (const [source, load] of bundled) {
    const mod = await load()
    if (typeof mod.default !== "function") throw new Error(`${source} has no default export`)
    out.push({ source, extension: mod.default as Extension })
  }
  return out
}
