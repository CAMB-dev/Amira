import { expect, test } from "bun:test"
import { createAi, createMockDialect, type MockStep } from "@amira/ai"
import type { AnyEvent, MarkdownNode, MarkdownRenderContext, MarkdownRendererDefinition } from "@amira/api"
import { MarkdownRendererRegistry } from "@amira/core"
import { runPrint } from "../src/print.ts"
import { PrintMarkdown } from "../src/print-markdown.ts"
import { createSession } from "../src/session.ts"

async function session(steps: MockStep[]) {
  const ai = createAi({
    dialects: [createMockDialect(steps)],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "", defaultModel: { contextWindow: 128_000 } }],
  })
  return createSession({ model: "mock/m", cwd: import.meta.dir, extensions: [], noBuiltins: true, ai })
}

function capture() {
  return {
    out: "",
    err: "",
    stdout(text: string) {
      this.out += text
    },
    stderr(text: string) {
      this.err += text
    },
  }
}

function registry(...definitions: MarkdownRendererDefinition[]) {
  const result = new MarkdownRendererRegistry()
  for (const definition of definitions) result.register(definition)
  return result
}

const mathRenderer: MarkdownRendererDefinition = {
  id: "math",
  match: { math: "both" },
  render: (node) =>
    node.type !== "math"
      ? undefined
      : node.display
        ? { lines: [{ kind: "text", text: `display(${node.source})` }] }
        : { segments: [{ kind: "accent", text: `inline(${node.source})` }] },
}

async function print(source: string, markdownRenderers: MarkdownRendererRegistry, json = false) {
  const { agent } = await session([{ text: source }])
  const io = capture()
  try {
    expect(await runPrint(agent, "go", json, { io, markdownRenderers })).toBe(0)
    return io
  } finally {
    await agent.dispose("exit")
  }
}

test("plain runPrint renders completed fences, standalone images and both math forms", async () => {
  const nodes: MarkdownNode[] = []
  const contexts: MarkdownRenderContext[] = []
  const renderers = registry(
    mathRenderer,
    {
      id: "code",
      match: { codeLang: ["diagram"] },
      render(node, context) {
        nodes.push(node)
        contexts.push(context)
        return { lines: [{ kind: "accent", text: "a diagram" }] }
      },
    },
    {
      id: "image",
      match: { image: true },
      render(node) {
        nodes.push(node)
        return { image: { data: new Uint8Array([1, 2, 3]) }, alt: "image alternative" }
      },
    },
  )
  const source =
    "# Raw **heading**\n\n```Diagram title\na -> b\n```\n\n![plot](plot.png)\n\n$$\nx+y\n$$\n\\[z\\]\n\nText $a$ then \\(b\\), **still Markdown**.\n"
  const io = await print(source, renderers)
  expect(io.out).toBe(
    "# Raw **heading**\n\na diagram\n\nimage alternative\n\ndisplay(x+y)\ndisplay(z)\n\nText inline(a) then inline(b), **still Markdown**.\n",
  )
  expect(nodes).toEqual([
    { type: "code", lang: "Diagram", info: "Diagram title", code: "a -> b" },
    { type: "image", alt: "plot", url: "plot.png" },
  ])
  expect(contexts).toEqual([
    { width: process.stdout.columns || 80, images: false, maxImageRows: 0, theme: { dark: true } },
  ])
  expect(io.err).toBe("")
})

test("unclaimed and declined source preserves whitespace, CRLF and Markdown bytes", async () => {
  const source =
    "\r\n#  Header\r\n\r\n**bold**\tand [link](url)  \r\n~~~other info\r\nx\r\n~~~~  \r\n\r\n![alt](url)\r\n$$ x $$\r\nInline $a$ and \\(b\\).\r\n"
  expect((await print(source, registry())).out).toBe(source)
  const declined = registry(
    { id: "math", match: { math: "both" }, render: async () => undefined },
    { id: "code", match: { codeLang: ["other"] }, render: () => undefined },
    { id: "image", match: { image: true }, render: () => undefined },
  )
  expect((await print(source, declined)).out).toBe(source)
})

test("currency, escaped delimiters and code spans are not inline math", async () => {
  const source =
    "Cost $5 and $10\n\\$escaped$\n`$code$` and ``\\(code\\)``\n$ spaced$\n$trailing $\n$x$2\nValid $yes$ and \\(ok\\).\n"
  expect((await print(source, registry(mathRenderer))).out).toBe(
    source.replace("$yes$", "inline(yes)").replace("\\(ok\\)", "inline(ok)"),
  )
})

test("multiline code spans exclude inline and display math across writes", async () => {
  for (const body of ["$x$", "$$x$$", "\\[x\\]", "$$\nx\n$$", "\\[\nx\n\\]"]) {
    const source = `Use \`cost\n${body}\nvalue\` here. $yes$\n`
    let out = ""
    const stream = new PrintMarkdown(registry(mathRenderer), (text) => {
      out += text
    })
    for (const char of source) await stream.write(char)
    await stream.finish()
    expect(out).toBe(source.replace("$yes$", "inline(yes)"))
  }
})

test("display-only claims respect multiline code spans and preserve CRLF", async () => {
  const source = "Use ``cost\r\n` $x$ `\r\n$$y$$\r\n\\[z\\]\r\nvalue`` here.\r\n$$yes$$\r\n"
  const renderers = registry({ ...mathRenderer, match: { math: "display" } })
  let out = ""
  const stream = new PrintMarkdown(renderers, (text) => {
    out += text
  })
  for (const char of source) await stream.write(char)
  await stream.finish()
  expect(out).toBe(source.replace("$$yes$$", "display(yes)"))
})

test("unmatched backticks do not hide later real math", async () => {
  const source = "Use `cost\n$x$\n$$y$$\n\\[z\\]\nafter\n"
  expect((await print(source, registry(mathRenderer))).out).toBe(
    "Use `cost\ninline(x)\ndisplay(y)\ndisplay(z)\nafter\n",
  )
})

test("unclosed blocks and expressions are left as source at the end of a message", async () => {
  for (const source of ["```diagram\n$x$\n", "$$\n$x$\n", "\\[\nx+y\n", "Text $x and \\(y\n"]) {
    const renderers = registry(mathRenderer, {
      id: "code",
      match: { codeLang: ["diagram"] },
      render: () => {
        throw new Error("an unclosed fence must not render")
      },
    })
    expect((await print(source, renderers)).out).toBe(source)
  }
})

test("code fences exclude math even when their language is unclaimed", async () => {
  const source = "```plain\n$x$\n$$\ny\n$$\n```\n\nReal $z$.\n"
  expect((await print(source, registry(mathRenderer))).out).toBe(source.replace("$z$", "inline(z)"))
})

test("renderer failures and images without alternatives preserve source without graphics", async () => {
  const source = "```diagram\nx\n```\n![alt](url)\n"
  const renderers = registry(
    {
      id: "code",
      match: { codeLang: ["diagram"] },
      render: async () => {
        throw new Error("no")
      },
    },
    {
      id: "image",
      match: { image: true },
      render: () => ({ image: { url: "https://example.test/image.png" } }),
    },
  )
  expect((await print(source, renderers)).out).toBe(source)
  const fallback = registry({
    id: "image",
    match: { image: true },
    render: () => ({
      image: { url: "never-opened.png" },
      alt: "unused",
      fallback: [{ kind: "text", text: "fallback" }],
    }),
  })
  expect((await print("![alt](url)\n", fallback)).out).toBe("fallback\n")
})

test("inline images in surrounding text remain raw Markdown", async () => {
  let calls = 0
  const renderers = registry({
    id: "image",
    match: { image: true },
    render: () => {
      calls++
      return { lines: [{ kind: "text", text: "image" }] }
    },
  })
  const source = "See ![alt](url) here.\n"
  expect((await print(source, renderers)).out).toBe(source)
  expect(calls).toBe(0)
})

test("async rendering cannot be overtaken by later nodes or raw text and runPrint waits", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const rendering = new Promise<void>((resolve) => {
    started = resolve
  })
  const seen: string[] = []
  const renderers = registry({
    id: "math",
    match: { math: "both" },
    async render(node) {
      if (node.type !== "math") return
      seen.push(node.source)
      if (node.source === "first") {
        started()
        await gate
      }
      return node.display
        ? { lines: [{ kind: "text", text: "FIRST" }] }
        : { segments: [{ kind: "text", text: "SECOND" }] }
    },
  })
  const { agent } = await session([{ text: "before\n\n$$first$$\n\na $second$ after\n" }])
  const io = capture()
  let done = false
  const run = runPrint(agent, "go", false, { io, markdownRenderers: renderers, flushTimeoutMs: 1 }).then(
    (code) => {
      done = true
      return code
    },
  )
  try {
    await rendering
    await agent.bus.flush()
    await Bun.sleep(20)
    expect(done).toBe(false)
    expect(io.out).toBe("before\n\n")
    expect(seen).toEqual(["first"])
    release()
    expect(await run).toBe(0)
    expect(io.out).toBe("before\n\nFIRST\n\na SECOND after\n")
    expect(seen).toEqual(["first", "second"])
  } finally {
    release()
    await run
    await agent.dispose("exit")
  }
})

test("JSON runPrint never calls Markdown renderers or changes text deltas", async () => {
  let calls = 0
  const renderers = registry({
    id: "math",
    match: { math: "both" },
    render: () => {
      calls++
      return { lines: [{ kind: "text", text: "changed" }] }
    },
  })
  const source = "$$x$$\nraw $y$\n"
  const io = await print(source, renderers, true)
  const events: AnyEvent[] = io.out
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  expect(
    events
      .flatMap((event) =>
        event.type === "message.delta" && event.data.kind === "text" ? [event.data.text] : [],
      )
      .join(""),
  ).toBe(source)
  expect(calls).toBe(0)
})

test("every delimiter can arrive across one-character writes", async () => {
  let out = ""
  const stream = new PrintMarkdown(registry(mathRenderer), (text) => {
    out += text
  })
  const source = "$$\nx\n$$\n\\[\ny\\]\nA $z$ and \\(w\\).\n"
  for (const character of source) await stream.write(character)
  await stream.finish()
  expect(out).toBe("display(x)\ndisplay(y)\nA inline(z) and inline(w).\n")
})
