import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { Settings, SettingsLayers } from "@amira/api"
import { createSession } from "../src/session.ts"

const cwd = mkdtempSync(join(tmpdir(), "amira-session-concurrency-"))
let savedHome: string | undefined
beforeAll(() => {
  savedHome = process.env.AMIRA_HOME
  process.env.AMIRA_HOME = cwd
})
afterAll(() => {
  if (savedHome === undefined) delete process.env.AMIRA_HOME
  else process.env.AMIRA_HOME = savedHome
  rmSync(cwd, { recursive: true, force: true })
})

for (const value of [0, -1, 1.5, 2]) {
  test(`direct session concurrency setting ${value} is validated before constructing agents`, async () => {
    const session = await createSession({
      cwd,
      ai: createAi({
        dialects: [createMockDialect([])],
        providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      }),
      model: "mock/m",
      extensions: [],
      noBuiltins: true,
      settings: { maxParallelTools: value, subagents: { maxConcurrent: value } },
    })
    expect(session.agent.maxParallelTools).toBe(value === 2 ? 2 : 8)
    expect(session.tree.maxConcurrent).toBe(value === 2 ? 2 : 4)
    const warnings = session.startupEvents.flatMap((event) =>
      event.type === "extension.error" && event.data.source === "settings" ? [event.data.error] : [],
    )
    expect(warnings).toEqual(
      value === 2
        ? []
        : [
            `settings: "maxParallelTools" must be a whole number of at least 1, got ${value}; using default 8`,
            `settings: "subagents.maxConcurrent" must be a whole number of at least 1, got ${value}; using default 4`,
          ],
    )
  })
}

const invalidWarnings = [
  'settings: "maxParallelTools" must be a whole number of at least 1, got 0; using default 8',
  'settings: "subagents.maxConcurrent" must be a whole number of at least 1, got -1; using default 4',
]

for (const path of ["session", "session loader", "extension save"] as const) {
  test(`${path} reload normalizes concurrency for consumers and warns on each invalid reload`, async () => {
    const raw: Settings = {
      // Direct callers need not validate unrelated settings, even on reload.
      model: "raw fixture",
      maxParallelTools: 0,
      subagents: { maxConcurrent: -1, maxDepth: 2 },
    }
    const layers: SettingsLayers = {
      maxParallelTools: [{ scope: "user", file: "settings.json", value: 0 }],
    }
    const snapshots: Settings[] = []
    const layerSnapshots: SettingsLayers["maxParallelTools"][] = []
    const published: Settings[] = []
    const warnings: string[] = []
    const session = await createSession({
      cwd,
      ai: createAi({
        dialects: [createMockDialect([])],
        providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      }),
      model: "mock/m",
      extensions: [],
      noBuiltins: false,
      settings: raw,
      settingsLayers: layers,
      ...(path !== "session"
        ? {
            reloadSettings: () => ({ settings: raw, layers, warnings: ["loader warning"] }),
          }
        : {}),
      onSettingsReload: (settings) => published.push(structuredClone(settings)),
      builtins: async () => [
        {
          source: "consumer",
          extension: (api) => {
            snapshots.push(structuredClone(api.settings))
            layerSnapshots.push(api.settings.layers("maxParallelTools"))
            api.settings.declare({
              fields: [{ key: "enabled", type: "toggle", label: "Enabled", default: true }],
            })
          },
        },
      ],
    })
    const stop = session.agent.bus.subscribe((event) => {
      if (event.type === "extension.error" && event.data.source === "settings") {
        warnings.push(event.data.error)
      }
    })
    const normalized = { ...raw, maxParallelTools: 8, subagents: { ...raw.subagents, maxConcurrent: 4 } }
    const reload = async () => {
      if (path === "extension save") {
        await session.host.extensionSettings.get("consumer")!.save({ enabled: false }, "user")
        // Settings snapshots are intentionally immutable; a new consumer sees the updated host state.
        const loaded = await session.host.load((api) => {
          snapshots.push(structuredClone(api.settings))
          layerSnapshots.push(api.settings.layers("maxParallelTools"))
        }, "probe")
        expect(loaded).toBe(true)
        session.host.unload("probe")
      } else {
        await session.reload()
      }
      await session.agent.bus.flush()
    }
    try {
      expect(snapshots).toEqual([{ ...normalized, shell: "auto" }])
      expect(layerSnapshots).toEqual([layers.maxParallelTools])
      expect(
        session.startupEvents.flatMap((event) =>
          event.type === "extension.error" && event.data.source === "settings" ? [event.data.error] : [],
        ),
      ).toEqual(invalidWarnings)
      for (let i = 0; i < 2; i++) {
        warnings.length = 0
        await reload()
        expect(snapshots.at(-1)).toEqual({ ...normalized, shell: "auto" })
        expect(layerSnapshots.at(-1)).toEqual(layers.maxParallelTools)
        expect(published.at(-1)).toEqual(normalized)
        expect(published).toHaveLength(i + 1)
        expect(warnings).toEqual(
          path === "session" ? invalidWarnings : ["loader warning", ...invalidWarnings],
        )
        expect(raw.maxParallelTools).toBe(0)
        expect(raw.subagents?.maxConcurrent).toBe(-1)
      }
      raw.maxParallelTools = 2
      raw.subagents = { maxConcurrent: 3, maxDepth: 2 }
      warnings.length = 0
      await reload()
      expect(snapshots.at(-1)).toEqual({ ...raw, shell: "auto" })
      expect(published.at(-1)).toEqual(raw)
      expect(published).toHaveLength(3)
      expect(warnings).toEqual(path === "session" ? [] : ["loader warning"])
      // Reload publishes settings; it does not reconfigure existing agents or their tree.
      expect(session.agent.maxParallelTools).toBe(8)
      expect(session.tree.maxConcurrent).toBe(4)
    } finally {
      stop()
      session.host.unloadAll()
    }
  })
}
