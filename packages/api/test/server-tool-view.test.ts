import { expect, test } from "bun:test"
import type { ServerToolBlock } from "@amira/ai"
import { PROVIDER_SEARCH, serverToolView } from "../src/index.ts"

const search: ServerToolBlock = {
  type: "serverTool",
  id: "ws_1",
  name: "web_search",
  input: { type: "search", query: "bun" },
  status: "done",
  sources: [{ url: "https://bun.sh", title: "Bun" }, { url: "https://bun.sh/docs" }],
}

test("serverToolView: a finished search with its sources, as a presenter's ToolCallView", () => {
  const view = serverToolView(search)
  expect(view).toEqual({
    name: "web_search",
    args: { query: "bun" },
    result: {
      content: [{ type: "text", text: 'Web search: "bun"\nBun https://bun.sh\nhttps://bun.sh/docs' }],
      details: {
        backend: PROVIDER_SEARCH,
        results: [
          { title: "Bun", url: "https://bun.sh" },
          { title: "https://bun.sh/docs", url: "https://bun.sh/docs" },
        ],
        failures: [],
        native: true,
      },
    },
    text: 'Web search: "bun"\nBun https://bun.sh\nhttps://bun.sh/docs',
  })
})

test("serverToolView: page lookups, failures with their code, and unfinished blocks", () => {
  expect(
    serverToolView({ ...search, input: { type: "find_in_page", url: "https://a.b", pattern: "x" } }).args,
  ).toEqual({ url: "https://a.b", pattern: "x" })
  const failed = serverToolView({
    ...search,
    status: "failed",
    sources: [],
    input: { query: "bun", error_code: "too_many_requests" },
  })
  expect(failed.result.isError).toBe(true)
  expect(failed.text).toBe('Web search: "bun"\nError: too_many_requests')
  expect(failed.rejected).toBeUndefined()
  const running = serverToolView({ ...search, status: "running", sources: undefined })
  expect(running.rejected).toBe("aborted")
  expect(running.result.details?.results).toEqual([])
})
