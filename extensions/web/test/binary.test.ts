import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import type { ToolContext, ToolSession, WebFetchDetails } from "@amira/api"
import { artifactDir, SessionStore } from "../../../packages/core/src/index.ts"
import { webTools } from "../src/index.ts"
import { ctx, mockFetch, publicResolver, text } from "./util.ts"

let dir: string
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "amira-web-binary-")))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function sessionContext(): ToolContext {
  return { ...ctx(), session: { dir: join(dir, "session"), outputDir: dir } as ToolSession }
}

function tools(handler: Parameters<typeof mockFetch>[0], settings = {}) {
  const mock = mockFetch(handler)
  return webTools({ fetch: settings }, { fetch: mock.fetch, resolve: publicResolver() })
}

test("PDF by header is saved without putting its body in context", async () => {
  const body = "%PDF-1.7 secret document content"
  const { webFetch } = tools(() => new Response(body, { headers: { "content-type": "application/pdf" } }))
  const result = await webFetch.execute({ url: "https://x.test/report.pdf" }, sessionContext())
  expect(result.isError, text(result)).toBeUndefined()
  const details = result.details as WebFetchDetails
  expect(details.saved).toBeDefined()
  const saved = details.saved!
  expect(saved.path).toStartWith(dir)
  expect(saved.name).toMatch(/^report-[\da-f]+\.pdf$/)
  expect(saved.contentType).toBe("application/pdf")
  expect(saved.bytes).toBe(Buffer.byteLength(body))
  expect(await readFile(saved.path, "utf8")).toBe(body)
  expect(text(result)).toContain(saved.path)
  expect(text(result)).toContain("Final URL: https://x.test/report.pdf")
  expect(text(result)).toContain("application/pdf")
  expect(text(result)).toContain(`${Buffer.byteLength(body)} bytes`)
  expect(text(result)).toContain("PDF text extractor")
  expect(text(result)).not.toContain("secret document content")
  expect(text(result)).toContain("untrusted file")
  expect(result.persistDetails).toBe(true)
})

for (const contentType of ["", "application/octet-stream"]) {
  test(`PDF sniffing replays split chunks and bypasses the text cap (${contentType || "no header"})`, async () => {
    const parts = ["%P", "DF-1.7\n", "secret ".repeat(1000)]
    const body = parts.join("")
    const { webFetch } = tools(
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              const part = parts.shift()
              if (part === undefined) controller.close()
              else controller.enqueue(new TextEncoder().encode(part))
            },
          }),
          { headers: contentType ? { "content-type": contentType } : {} },
        ),
      { maxBytes: 2 },
    )
    const result = await webFetch.execute({ url: "https://x.test/download.exe" }, sessionContext())
    expect(result.isError, text(result)).toBeUndefined()
    const saved = (result.details as WebFetchDetails).saved!
    expect(saved.name).toMatch(/^download-[\da-f]+\.pdf$/)
    expect(saved.contentType).toBe("application/pdf")
    expect(saved.bytes).toBe(Buffer.byteLength(body))
    expect(await readFile(saved.path, "utf8")).toBe(body)
    expect(text(result)).not.toContain("secret")
  })
}

for (const contentType of ["image/png", "application/octet-stream"]) {
  test(`other binary is saved byte-for-byte (${contentType})`, async () => {
    const bytes = new Uint8Array([0x89, 0, 0xff, 1, 2, 3])
    const { webFetch } = tools(() => new Response(bytes, { headers: { "content-type": contentType } }))
    const result = await webFetch.execute({ url: "https://x.test/image.exe" }, sessionContext())
    expect(result.isError, text(result)).toBeUndefined()
    const saved = (result.details as WebFetchDetails).saved!
    expect(saved.bytes).toBe(bytes.length)
    expect(new Uint8Array(await readFile(saved.path))).toEqual(bytes)
    expect(saved.contentType).toBe(contentType)
    if (contentType === "image/png") expect(saved.name).toEndWith(".png")
  })
}

test("sniffed binary with no type or URL extension uses octet-stream and .bin", async () => {
  const { webFetch } = tools(() => new Response(new Uint8Array([0, 255])))
  const result = await webFetch.execute({ url: "https://x.test/" }, sessionContext())
  const saved = (result.details as WebFetchDetails).saved!
  expect(saved.contentType).toBe("application/octet-stream")
  expect(saved.name).toMatch(/^download-[\da-f]+\.bin$/)
})

test("binary cap counts streamed bytes, cancels the body and removes partial files", async () => {
  let cancelled = false
  let pulls = 0
  const { webFetch } = tools(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulls++
            controller.enqueue(new Uint8Array(4))
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: { "content-type": "application/pdf", "content-length": "1" } },
      ),
    { maxBinaryBytes: 7 },
  )
  const result = await webFetch.execute({ url: "https://x.test/too-large.pdf" }, sessionContext())
  expect(result.isError).toBe(true)
  expect(text(result)).toContain("7 byte download cap (web.fetch.maxBinaryBytes)")
  expect(await readdir(dir)).toEqual([])
  expect(cancelled).toBe(true)
  expect(pulls).toBeLessThan(10)
})

test("sniffed PDF over the binary cap is not saved truncated", async () => {
  const { webFetch } = tools(() => new Response("%PDF-1.7 content"), { maxBinaryBytes: 5 })
  const result = await webFetch.execute({ url: "https://x.test/file" }, sessionContext())
  expect(result.isError).toBe(true)
  expect(text(result)).toContain("5 byte download cap")
  expect(await readdir(dir)).toEqual([])
})

test("a binary exactly at the cap succeeds", async () => {
  const { webFetch } = tools(() => new Response("%PDF-"), { maxBinaryBytes: 5 })
  const result = await webFetch.execute({ url: "https://x.test/file" }, sessionContext())
  expect(result.isError, text(result)).toBeUndefined()
  expect((result.details as WebFetchDetails).saved?.bytes).toBe(5)
})

test("filenames are portable single components, MIME-correct and unique across parallel calls", async () => {
  const { webFetch } = tools(
    () => new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }),
  )
  for (const name of ["%2e%2e%2f%2e%2e%5cCON%00%3a%3f.exe", "NUL", "%ZZ", "a".repeat(300)]) {
    const results = await Promise.all(
      Array.from({ length: 2 }, () => webFetch.execute({ url: `https://x.test/${name}` }, sessionContext())),
    )
    const paths = results.map((result) => {
      expect(result.isError, text(result)).toBeUndefined()
      const saved = (result.details as WebFetchDetails).saved!
      expect(dirname(saved.path)).toBe(dir)
      expect(basename(saved.path)).toBe(saved.name)
      expect(saved.name).toMatch(/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*-[\da-f]+\.pdf$/)
      expect(saved.name.length).toBeLessThan(110)
      return saved.path
    })
    expect(paths[0]).not.toBe(paths[1])
  }
  expect(await readdir(dir)).toHaveLength(8)
})

test("no session directory preserves the error with an explicit reason; downloads are not cached", async () => {
  const { webFetch } = tools(
    () => new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }),
  )
  const first = await webFetch.execute({ url: "https://x.test/a.pdf" }, sessionContext())
  expect(first.isError, text(first)).toBeUndefined()
  for (const context of [
    ctx(),
    { ...ctx(), session: { dir } as ToolSession },
    { ...ctx(), session: { outputDir: dir } as ToolSession },
  ]) {
    const result = await webFetch.execute({ url: "https://x.test/a.pdf" }, context)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain("is a PDF; web_fetch cannot extract text from PDFs yet")
    expect(text(result)).toContain("no session output directory")
  }
  expect(await readdir(dir)).toHaveLength(1)
})

test("a redirect to PDF reports the final URL and uses its basename", async () => {
  const { webFetch } = tools((url) =>
    url.endsWith("/start")
      ? new Response(null, { status: 302, headers: { location: "https://cdn.test/final.pdf" } })
      : new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }),
  )
  const result = await webFetch.execute({ url: "https://x.test/start" }, sessionContext())
  expect(result.isError, text(result)).toBeUndefined()
  expect(result.details).toMatchObject({
    url: "https://x.test/start",
    finalUrl: "https://cdn.test/final.pdf",
  })
  expect((result.details as WebFetchDetails).saved?.name).toMatch(/^final-[\da-f]+\.pdf$/)
  expect(text(result)).toContain("Final URL: https://cdn.test/final.pdf")
})

test("HTTP errors and blocked redirects do not create download files", async () => {
  const { webFetch } = tools((url) =>
    url.endsWith("/error")
      ? new Response("%PDF-error", { status: 404, headers: { "content-type": "application/pdf" } })
      : new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private.pdf" } }),
  )
  const error = await webFetch.execute({ url: "https://x.test/error" }, sessionContext())
  expect(text(error)).toContain("HTTP 404")
  const blocked = await webFetch.execute({ url: "https://x.test/redirect" }, sessionContext())
  expect(text(blocked)).toContain("refusing to fetch")
  expect(await readdir(dir)).toEqual([])
})

test("stream failures remove incomplete binary files", async () => {
  let pulls = 0
  const { webFetch } = tools(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (pulls++ === 0) controller.enqueue(new Uint8Array(1024))
            else controller.error(new Error("broken body"))
          },
        }),
        { headers: { "content-type": "application/pdf" } },
      ),
  )
  const result = await webFetch.execute({ url: "https://x.test/broken.pdf" }, sessionContext())
  expect(result.isError).toBe(true)
  expect(text(result)).toContain("broken body")
  expect(await readdir(dir)).toEqual([])
})

for (const header of [true, false]) {
  test(`timeout cancels a stalled ${header ? "declared binary" : "sniffing"} body`, async () => {
    let cancelled = false
    const { webFetch } = tools(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("%PDF-"))
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: header ? { "content-type": "application/pdf" } : {} },
        ),
      { timeoutMs: 30 },
    )
    const result = await webFetch.execute({ url: "https://x.test/slow" }, sessionContext())
    expect(result.isError).toBe(true)
    expect(text(result)).toContain("timed out after 30 ms")
    expect(cancelled).toBe(true)
    expect(await readdir(dir)).toEqual([])
  })
}

test("caller abort removes the partial file and propagates the abort", async () => {
  const ac = new AbortController()
  let cancelled = false
  const { webFetch } = tools(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(4096))
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: { "content-type": "application/pdf" } },
      ),
  )
  const pending = webFetch.execute(
    { url: "https://x.test/slow.pdf" },
    { ...sessionContext(), signal: ac.signal },
  )
  const timer = setTimeout(() => ac.abort(new Error("stopped")), 30)
  try {
    await expect(pending).rejects.toThrow("stopped")
    expect(cancelled).toBe(true)
    expect(await readdir(dir)).toEqual([])
  } finally {
    clearTimeout(timer)
  }
})

test("a failed output-directory write cancels the response without claiming a saved file", async () => {
  const { writeFile } = await import("node:fs/promises")
  const blocked = join(dir, "not-a-directory")
  await writeFile(blocked, "existing")
  let cancelled = false
  const { webFetch } = tools(
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          },
        }),
        { headers: { "content-type": "application/pdf" } },
      ),
  )
  const context = { ...ctx(), session: { dir: join(dir, "session"), outputDir: blocked } as ToolSession }
  const result = await webFetch.execute({ url: "https://x.test/file.pdf" }, context)
  expect(result.isError).toBe(true)
  expect(result.details).toBeUndefined()
  expect(cancelled).toBe(true)
  expect(await readFile(blocked, "utf8")).toBe("existing")
  expect(await readdir(dir)).toEqual(["not-a-directory"])
})

test("Windows device names before the first dot are neutralized", async () => {
  const { webFetch } = tools(() => new Response("%PDF-1.7"))
  for (const name of ["CON.report.pdf", "NUL.backup.zip", "COM1.archive.tar", "lpt9.log.pdf"]) {
    const result = await webFetch.execute({ url: `https://x.test/${name}` }, sessionContext())
    expect(result.isError, text(result)).toBeUndefined()
    const saved = (result.details as WebFetchDetails).saved!
    expect(saved.name).not.toMatch(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i)
    expect(await readFile(saved.path, "utf8")).toBe("%PDF-1.7")
  }
})

for (const header of [true, false]) {
  test(`timeout does not wait for deferred ${header ? "binary" : "sniffing"} cancellation`, async () => {
    let release!: () => void
    const cancellation = new Promise<void>((resolve) => {
      release = resolve
    })
    const { webFetch } = tools(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("%PDF-"))
            },
            cancel: () => cancellation,
          }),
          { headers: header ? { "content-type": "application/pdf" } : {} },
        ),
      { timeoutMs: 20 },
    )
    const pending = webFetch.execute({ url: "https://x.test/deferred" }, sessionContext())
    try {
      const timely = await Promise.race([pending, Bun.sleep(200).then(() => undefined)])
      expect(timely).toBeDefined()
      expect(text(timely!)).toContain("timed out after 20 ms")
      expect(await readdir(dir)).toEqual([])
    } finally {
      release()
      await pending
    }
  })
}

for (const level of ["outputs", "assets"]) {
  test(`a ${level} junction/symlink cannot redirect downloads outside session storage`, async () => {
    const storage = join(dir, "sessions")
    const outside = join(dir, "sessions-outside")
    await mkdir(storage)
    await mkdir(outside)
    const session = SessionStore.create({ cwd: dir, dir: storage })
    const outputDir = artifactDir(session.file, session.id)
    const assets = dirname(outputDir)
    if (level === "outputs") await mkdir(assets)
    await symlink(
      outside,
      level === "outputs" ? outputDir : assets,
      process.platform === "win32" ? "junction" : "dir",
    )
    const context = {
      ...ctx(),
      session: { dir: session.file.replace(/\.jsonl$/, ""), outputDir } as ToolSession,
    }
    const { webFetch } = tools(
      () => new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }),
    )
    const result = await webFetch.execute({ url: "https://x.test/escape.pdf" }, context)
    expect(result.isError, text(result)).toBe(true)
    expect(text(result)).toContain("escapes session storage")
    expect(result.details).toBeUndefined()
    expect(await readdir(outside)).toEqual([])
  })
}

test("a stalled headerless text response still returns a small truncated budget", async () => {
  let cancelled = false
  const { webFetch } = tools(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("abcdefghijklmnopq"))
          },
          cancel() {
            cancelled = true
          },
        }),
      ),
    { maxBytes: 16, timeoutMs: 100 },
  )
  const result = await webFetch.execute({ url: "https://x.test/stalled-text" }, ctx())
  expect(result.isError, text(result)).toBeUndefined()
  expect(text(result)).toContain("larger than the download limit")
  expect(text(result)).toEndWith("abcdefghijklmnop")
  expect(cancelled).toBe(true)
})

test("an in-root output alias is pinned to its real directory", async () => {
  const storage = join(dir, "sessions")
  const actual = join(storage, "actual-outputs")
  await mkdir(actual, { recursive: true })
  const session = SessionStore.create({ cwd: dir, dir: storage })
  const outputDir = artifactDir(session.file, session.id)
  await mkdir(dirname(outputDir))
  await symlink(actual, outputDir, process.platform === "win32" ? "junction" : "dir")
  const { webFetch } = tools(() => new Response("%PDF-1.7"))
  const context = {
    ...ctx(),
    session: { dir: session.file.replace(/\.jsonl$/, ""), outputDir } as ToolSession,
  }
  const result = await webFetch.execute({ url: "https://x.test/pinned.pdf" }, context)
  expect(result.isError, text(result)).toBeUndefined()
  const saved = (result.details as WebFetchDetails).saved!
  expect(dirname(saved.path)).toBe(await realpath(actual))
  expect(await realpath(saved.path)).toBe(saved.path)
  expect(await readFile(saved.path, "utf8")).toBe("%PDF-1.7")
})
