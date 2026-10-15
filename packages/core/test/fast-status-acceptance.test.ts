import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, type FastOption, type Usage } from "@amira/ai"
import { Agent } from "../src/agent.ts"

test.each([
  ["https://api.anthropic.com", { kind: "anthropic-speed" }, { serviceTier: "priority" }, undefined],
  [
    "https://gateway.invalid",
    { kind: "service-tier", value: "priority" },
    { serviceTier: "priority", speed: "standard" },
    "priority",
  ],
] satisfies [string, FastOption, Partial<Usage>, string | undefined][])(
  "live and restored fast status uses the declared option (%s, %j)",
  async (baseUrl, fast, usage, expected) => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "amira-fast-status-acceptance-"))
    const mock = createMockDialect([{ text: "done", usage }])
    mock.id = "anthropic-messages"
    const ai = createAi({
      dialects: [mock],
      providers: [
        {
          id: "p",
          dialect: mock.id,
          baseUrl,
          models: [{ id: "claude-opus-5-5", fast, cost: { input: 5, output: 25 } }],
        },
      ],
    })
    const agent = new Agent({ ai, cwd, model: ai.model("p/claude-opus-5-5"), fastMode: true })
    let restored: Agent | undefined
    try {
      await agent.prompt("go")
      expect(agent.lastSpeed).toBe(expected)
      restored = new Agent({ ai, cwd, model: agent.model, messages: agent.messages, fastMode: true })
      expect(restored.lastSpeed).toBe(expected)
    } finally {
      await restored?.dispose()
      await agent.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  },
)
