import { expect, test } from "bun:test"
import type { Message, ServerToolBlock } from "@amira/ai"
import type { ToolPresenter } from "@amira/api"
import { defaultTheme, stripAnsi } from "@amira/tui-kit"
import { historyLines } from "../src/history.ts"
import { citationsMarkdown, replyCitations, serverToolCall } from "../src/server-tools.ts"

const search: ServerToolBlock = {
  type: "serverTool",
  id: "ws_1",
  name: "web_search",
  input: { type: "search", query: "node lts", queries: ["node lts", "node current"] },
  status: "done",
  sources: [{ url: "https://nodejs.org/en/download", title: "Download" }],
}

test("a hosted search as a tool row: its queries, the page it opened, how it ended", () => {
  const row = serverToolCall(search)
  expect(row.name).toBe("web_search")
  expect(row.args).toEqual({ query: "node lts · node current" })
  expect(row.result.isError).toBeUndefined()
  expect(row.rejected).toBeUndefined()
  expect(row.result.details).toMatchObject({
    native: true,
    results: [{ url: "https://nodejs.org/en/download" }],
  })
  expect(serverToolCall({ ...search, input: { type: "open_page", url: "https://a.b" } }).args).toEqual({
    url: "https://a.b",
  })
  expect(serverToolCall({ ...search, status: "failed" }).result.isError).toBe(true)
  expect(serverToolCall({ ...search, status: "running" }).rejected).toBe("aborted")
})

// As the web extension's presenter shows these rows (its own tests cover it).
const webSearchPresenter: ToolPresenter = {
  summary: (args) => `"${String(args.query)}"`,
  result: (call) =>
    `${(call.result.details as { results: unknown[] }).results.length} source · provider search`,
}

test("cited sources as Markdown links, once each, with link-breaking characters escaped", () => {
  expect(citationsMarkdown([])).toBe("")
  expect(citationsMarkdown([{ url: "https://x.y/a_(b)", title: "A [draft]" }, { url: "https://z.w" }])).toBe(
    "\n\nSources:\n1. [A \\[draft\\]](https://x.y/a_%28b%29)\n2. [https://z.w](https://z.w)",
  )
  expect(
    replyCitations([
      { type: "text", text: "a", citations: [{ url: "https://z.w", title: "Z" }] },
      { type: "text", text: "b", citations: [{ url: "https://z.w" }] },
    ]),
  ).toBe("\n\nSources:\n1. [Z](https://z.w)")
})

test("a resumed history shows the search as a row and the sources as clickable links", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "which node?" }] },
    {
      role: "assistant",
      model: { provider: "p", model: "m" },
      content: [
        search,
        {
          type: "text",
          text: "v24 is the LTS.",
          citations: [{ url: "https://nodejs.org/en/download", title: "Download Node.js" }],
        },
      ],
    },
  ]
  const presenters = { get: (name: string) => (name === "web_search" ? webSearchPresenter : undefined) }
  const raw = historyLines(defaultTheme, messages, { width: 80, hyperlinks: true, presenters })
  const lines = raw.map(stripAnsi)
  const row = lines.findIndex((l) => l.includes("web_search"))
  expect(lines[row]).toContain('"node lts · node current"')
  expect(lines[row + 1]).toContain("1 source · provider search")
  const reply = lines.findIndex((l) => l.includes("v24 is the LTS."))
  expect(reply).toBeGreaterThan(row)
  expect(lines.slice(reply).some((l) => l.includes("Sources:"))).toBe(true)
  expect(lines.slice(reply).some((l) => l.includes("1. Download Node.js"))).toBe(true)
  // The title links to the page (OSC 8).
  expect(raw.join("\n")).toContain("\x1b]8;;https://nodejs.org/en/download")
})
