import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AssistantMessage } from "@amira/ai"
import { estimateTokens, renderTranscript } from "../src/compaction.ts"
import { SessionStore } from "../src/session-store.ts"

for (const dialect of ["anthropic-messages", "google-gemini"]) {
  test(`${dialect}: opaque search history, citations, usage and suggestions survive sessions and summaries`, () => {
    const message: AssistantMessage = {
      role: "assistant",
      model: { provider: "p", model: "m" },
      content: [
        {
          type: "serverTool",
          id: "s",
          name: "web_search",
          input: { query: "release" },
          status: "done",
          sources: [{ url: "https://source.test", title: "Source" }],
          signature: { dialect, host: "host.test", value: "encrypted-result".repeat(30) },
          ...(dialect === "google-gemini"
            ? { searchEntryPoint: { renderedContent: "<div>Search</div>" } }
            : {}),
        },
        {
          type: "text",
          text: "Latest release.",
          citations: [{ url: "https://cited.test", title: "Cited", start: 0, end: 6 }],
          ...(dialect === "anthropic-messages"
            ? {
                signature: {
                  dialect,
                  host: "host.test",
                  kind: "webSearch" as const,
                  value: "encrypted-index".repeat(50),
                },
              }
            : {}),
        },
      ],
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        webSearchRequests: 2,
        webSearchCost: 0.02,
        cost: 0.03,
      },
    }
    const dir = mkdtempSync(path.join(os.tmpdir(), "amira-search-history-"))
    try {
      const session = SessionStore.create({ cwd: process.cwd(), dir })
      session.appendMessage(message)
      expect(SessionStore.open(session.file).restore().messages).toEqual([message])
      const transcript = renderTranscript([message])
      expect(transcript).toContain('Web search: "release"')
      expect(transcript).toContain("https://source.test")
      expect(transcript).toContain("https://cited.test")
      expect(transcript).not.toContain("encrypted-")
      const text = message.content[1]!
      const textLength = text.type === "text" ? (text.signature?.value ?? text.text).length : 0
      expect(estimateTokens([message])).toBe(
        Math.ceil(("encrypted-result".repeat(30).length + textLength) / 4),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
