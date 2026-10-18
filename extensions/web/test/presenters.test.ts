import { expect, test } from "bun:test"
import { textResult, toolResultText } from "@amira/api"
import { webFetchPresenter, webSearchPresenter } from "../src/presenters.ts"

const view = <A>(args: A, result: ReturnType<typeof textResult> & { details?: unknown }) => ({
  args,
  result,
  text: toolResultText(result),
})

test("web_search: the query as head, the number of results and the backend as result", () => {
  expect(webSearchPresenter.verbs).toEqual({ past: "Searched", running: "Searching" })
  expect(webSearchPresenter.summary!({ query: "bun 1.4 release" })).toBe('"bun 1.4 release"')
  const r = {
    ...textResult("1. A\n2. B"),
    details: {
      backend: "exa",
      results: [
        { title: "A", url: "a" },
        { title: "B", url: "b" },
      ],
      failures: [],
    },
  }
  expect(webSearchPresenter.result!(view({ query: "q" }, r) as never)).toBe("2 results · exa")
  expect(
    webSearchPresenter.body!(view({ query: "q" }, r) as never, { detail: "summary", width: 80 }),
  ).toEqual([])
})

test("web_fetch: the URL as head, where it ended up and its size as result", () => {
  expect(webFetchPresenter.verbs).toEqual({ past: "Fetched", running: "Fetching" })
  expect(webFetchPresenter.summary!({ url: "https://x.dev" })).toBe("https://x.dev")
  const d = { url: "https://x.dev/", finalUrl: "https://x.dev/", status: 200, length: 12_345 }
  const same = { ...textResult("page"), details: d }
  expect(webFetchPresenter.result!(view({ url: "u" }, same) as never)).toBe("12.3k chars")
  const moved = { ...textResult("page"), details: { ...d, finalUrl: "https://www.x.dev/", status: 203 } }
  expect(webFetchPresenter.result!(view({ url: "u" }, moved) as never)).toBe(
    "→ https://www.x.dev/ · 12.3k chars",
  )
})

test("web_fetch: saved binaries show name, type and bytes rather than text length", () => {
  const result = {
    ...textResult("Saved: /outputs/report-123.pdf"),
    details: {
      url: "https://x.dev/start",
      finalUrl: "https://x.dev/report.pdf",
      status: 200,
      length: 0,
      saved: {
        path: "/outputs/report-123.pdf",
        name: "report-123.pdf",
        contentType: "application/pdf",
        bytes: 1234,
      },
    },
  }
  expect(webFetchPresenter.result!(view({ url: "u" }, result) as never)).toBe(
    "→ https://x.dev/report.pdf · saved report-123.pdf (application/pdf, 1234 bytes)",
  )
  const same = { ...result, details: { ...result.details, url: result.details.finalUrl } }
  expect(webFetchPresenter.result!(view({ url: "u" }, same) as never)).toBe(
    "saved report-123.pdf (application/pdf, 1234 bytes)",
  )
  expect(webFetchPresenter.result!(view({ url: "u" }, { ...result, isError: true }) as never)).toBeUndefined()
})

test("web_search also shows the provider's hosted search rows: sources, pages opened", () => {
  const native = {
    backend: "provider search",
    results: [{ title: "D", url: "https://d" }],
    failures: [],
    native: true,
  }
  expect(
    webSearchPresenter.result!(view({ query: "node" }, { ...textResult("x"), details: native }) as never),
  ).toBe("1 source · provider search")
  const none = { ...native, results: [] }
  expect(
    webSearchPresenter.result!(view({ query: "node" }, { ...textResult("x"), details: none }) as never),
  ).toBe("provider search")
  expect(webSearchPresenter.summary!({ url: "https://a.b" })).toBe("https://a.b")
  expect(webSearchPresenter.summary!({ url: "https://a.b", pattern: "v2" })).toBe('"v2" in https://a.b')
})
