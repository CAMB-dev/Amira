import "./offline.ts"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { AgentStatusState, ExtensionStatusMetadata, UiApi } from "@amira/api"
import { createWorkspaceRuntime, type ServerEvent } from "../../src/server/runtime.ts"

test.each([false, true])(
  "select requests preserve lifecycle badges across reattachment (agent badges: %s)",
  async (agentBadges) => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-select-dto-"))
    let ui!: UiApi
    const runtime = await createWorkspaceRuntime({
      cwd,
      ai: createAi({
        dialects: [createMockDialect([])],
        providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      }),
      model: "mock/test",
      autoTitle: false,
      builtins: async () => [
        {
          source: "fixture",
          extension: (api) => {
            ui = api.ui
          },
        },
      ],
    })
    const events: ServerEvent[] = []
    const first = runtime.attach()
    const off = first.subscribeEvents((event) => {
      events.push(event)
    })
    const badges: (AgentStatusState | undefined)[] = ["done", undefined]
    const extensionBadges: (ExtensionStatusMetadata | undefined)[] = [
      { status: "deprecated", statusMessage: "Old", replacedBy: "replacement" },
      undefined,
    ]
    const answer = ui.choose("Agents and kept worktrees", ["finished", "worktree"], {
      sections: [{ at: 0, title: "Agents" }],
      ...(agentBadges ? { optionStatuses: badges } : {}),
      optionExtensionStatuses: extensionBadges,
    })
    try {
      await Bun.sleep(0)
      const pending = first.pendingRequests[0]!
      expect(pending.kind).toBe("select")
      if (pending.kind !== "select") throw new Error("Expected select request")
      expect(pending.optionStatuses).toEqual(agentBadges ? ["done", null] : undefined)
      expect(pending.optionExtensionStatuses).toEqual([extensionBadges[0]!, null])
      const published = events.find((event) => event.type === "ui.request")
      expect(published?.data).toMatchObject({
        kind: "select",
        ...(agentBadges ? { optionStatuses: ["done", null] } : {}),
        optionExtensionStatuses: [extensionBadges[0]!, null],
      })
      expect(JSON.parse(JSON.stringify(published))).toEqual(published)
      expect(badges[1]).toBeUndefined()
      expect(extensionBadges[1]).toBeUndefined()
      await first.detach()
      const next = runtime.attach()
      expect(next.pendingRequests[0]).toEqual(pending)
      expect(await next.request("ui.respond", { requestId: pending.requestId, value: "worktree" })).toEqual({
        status: "accepted",
      })
      expect(await answer).toEqual({ option: "worktree" })
      expect(next.pendingRequests).toHaveLength(0)
      await next.detach()
    } finally {
      off()
      await first.detach()
      await runtime.stop()
      await answer
      rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  },
)
