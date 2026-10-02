import { expect, test } from "bun:test"
import type { AnyEvent, ExtensionAPI } from "@amira/api"
import { EventBus } from "../src/event-bus.ts"
import { ExtensionHost } from "../src/extensions.ts"
import { amiraHome } from "../src/home.ts"
import { InterceptorRegistry } from "../src/interceptors.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

test("extensions get the cwd, the user directory and a way to report later failures", async () => {
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const host = new ExtensionHost({
    bus,
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
    cwd: "/some/project",
  })
  let api: ExtensionAPI | undefined
  await host.load((a) => {
    api = a
  }, "ext:test")
  expect(api!.cwd).toBe("/some/project")
  expect(api!.home).toBe(amiraHome())
  api!.reportError("server x failed")
  await bus.flush()
  expect(events.at(-1)).toMatchObject({
    type: "extension.error",
    data: { source: "ext:test", error: "server x failed" },
  })
})

test("tool renderers: the last one registered for a tool wins, and unloading restores the one before", async () => {
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
  })
  const first = { summary: () => "first" }
  const second = { summary: () => "second" }
  await host.load((api) => void api.registerToolRenderer("read", first), "ext:a")
  expect(host.renderers.get("read")).toBe(first)
  await host.load((api) => void api.registerToolRenderer("read", second), "ext:b")
  expect(host.renderers.get("read")).toBe(second)
  host.unload("ext:b")
  expect(host.renderers.get("read")).toBe(first)
  host.unload("ext:a")
  expect(host.renderers.get("read")).toBeUndefined()
})

test("views: the last registration wins, unloading restores it, and subagent is extension-owned", async () => {
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  const first = { kind: "workflow", title: () => "first", render: () => [] }
  const second = { kind: "workflow", title: () => "second", render: () => [] }
  const subagent = { kind: "subagent", title: () => "child", render: () => [] }
  await host.load((api) => void api.registerView(first), "ext:a")
  await host.load((api) => {
    api.registerView(second)
    api.registerView(subagent)
    api.registerView({ kind: " ", title: () => "", render: () => [] })
  }, "ext:b")
  expect(host.views.get("workflow")).toBe(second)
  expect(host.views.get("subagent")).toBe(subagent)
  expect(host.loaded).toContain("ext:b")
  await bus.flush()
  expect(events.find((e) => e.type === "extension.error")?.data).toEqual({
    source: "ext:b",
    error: "a view needs a kind",
  })
  host.unload("ext:b")
  expect(host.views.get("subagent")).toBeUndefined()
  expect(host.views.get("workflow")).toBe(first)
  host.unload("ext:a")
  expect(host.views.kinds()).toEqual([])
})

test("runCommand writes stdin, adding the newline, and closes it", async () => {
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
  })
  let api: ExtensionAPI | undefined
  await host.load((a) => {
    api = a
  }, "ext:stdin")
  const read =
    "let s = ''; for await (const c of process.stdin) s += c; process.stdout.write(JSON.stringify(s))"
  const opts = {
    cwd: process.cwd(),
    timeoutMs: 20_000,
    signal: new AbortController().signal,
    stdoutOnly: true,
  }
  const r = await api!.runCommand([process.execPath, "-e", read], { ...opts, stdin: '{"a":1}' })
  expect(r.exitCode).toBe(0)
  expect(JSON.parse(r.output)).toBe('{"a":1}\n')
  const same = await api!.runCommand([process.execPath, "-e", read], { ...opts, stdin: "x\n" })
  expect(JSON.parse(same.output)).toBe("x\n")
  await expect(api!.runCommand(["x"], { ...opts, stdin: "x", viaCmd: true })).rejects.toThrow("stdin")
})

test("runCommand streams output while the command runs, and an abort stops it", async () => {
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
  })
  let api: ExtensionAPI | undefined
  await host.load((a) => {
    api = a
  }, "ext:stream")
  const opts = { cwd: process.cwd(), timeoutMs: 20_000, signal: new AbortController().signal }

  const chunks: string[] = []
  let done = false
  let doneAtFirstChunk: boolean | undefined
  const script = "console.log('one'); await Bun.sleep(1000); console.log('two')"
  const run = api!.runCommand([process.execPath, "-e", script], {
    ...opts,
    onChunk: (c) => {
      doneAtFirstChunk ??= done
      chunks.push(c)
    },
  })
  void run.then(() => (done = true))
  const r = await run
  expect(doneAtFirstChunk).toBe(false)
  expect(chunks[0]).toContain("one")
  expect(chunks.join("")).toBe(r.output)
  expect(r.output).toContain("two")

  const abort = new AbortController()
  const started = performance.now()
  const stopped = await api!.runCommand(
    [process.execPath, "-e", "console.log('one'); await Bun.sleep(60_000)"],
    {
      ...opts,
      signal: abort.signal,
      onChunk: () => abort.abort(),
    },
  )
  expect(stopped).toMatchObject({ aborted: true, timedOut: false })
  expect(stopped.output).toContain("one")
  expect(performance.now() - started).toBeLessThan(20_000)
})

test("runCommand caps output at 1,000,000 characters by default, keeping the end", async () => {
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
  })
  let api: ExtensionAPI | undefined
  await host.load((a) => {
    api = a
  }, "ext:cap")
  const opts = { cwd: process.cwd(), timeoutMs: 20_000, signal: new AbortController().signal }
  let streamed = 0
  const r = await api!.runCommand(
    [process.execPath, "-e", "process.stdout.write('x'.repeat(1_000_000) + 'END')"],
    {
      ...opts,
      onChunk: (c) => {
        streamed += c.length
      },
    },
  )
  expect(r.output.length).toBe(1_000_000)
  expect(r.output.endsWith("xEND")).toBe(true)
  expect(r.truncated).toBe(true)
  expect(streamed).toBe(1_000_003)
  const small = await api!.runCommand([process.execPath, "-e", "process.stdout.write('x'.repeat(10))"], {
    ...opts,
    maxOutputChars: 4,
  })
  expect(small).toMatchObject({ output: "xxxx", truncated: true })
})

test("notify sends an extension.notice, info by default", async () => {
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  await host.load((api) => {
    api.notify("formatted a.ts")
    api.notify("tests failed", "error")
    // An unknown level (a slip, or a JavaScript extension) is shown as information.
    api.notify("odd", "loud" as never)
  }, "ext:hooks")
  await bus.flush()
  expect(events.filter((e) => e.type === "extension.notice").map((e) => e.data)).toEqual([
    { source: "ext:hooks", text: "formatted a.ts", level: "info" },
    { source: "ext:hooks", text: "tests failed", level: "error" },
    { source: "ext:hooks", text: "odd", level: "info" },
  ])
})

test("exit handlers run together; a slow one is cut off, a failing one reported, a removed one skipped", async () => {
  const bus = new EventBus()
  const events: AnyEvent[] = []
  bus.subscribe((e) => void events.push(e))
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  const ran: string[] = []
  let slowAborted = false
  await host.load((api) => {
    api.onExit(async () => {
      await Bun.sleep(10)
      ran.push("quick")
    })
    api.onExit(
      (signal) =>
        new Promise<void>((resolve) => {
          // Stopping takes a moment, which the grace after the abort allows for.
          signal.addEventListener("abort", () =>
            setTimeout(() => {
              slowAborted = true
              resolve()
            }, 50),
          )
        }),
    )
    api.onExit(() => {
      throw new Error("boom")
    })
    api.onExit(() => void ran.push("removed"))()
  }, "ext:a")
  await host.load((api) => void api.onExit(() => void ran.push("unloaded")), "ext:b")
  host.unload("ext:b")
  const started = Date.now()
  await host.runExitHandlers(100)
  expect(Date.now() - started).toBeLessThan(2000)
  expect(ran).toEqual(["quick"])
  expect(slowAborted).toBe(true)
  await bus.flush()
  expect(events.some((e) => e.type === "extension.error" && e.data.error.includes("boom"))).toBe(true)
})

test("exit handlers run after the extensions got session.end", async () => {
  const bus = new EventBus()
  const host = new ExtensionHost({ bus, interceptors: new InterceptorRegistry(), tools: new ToolRegistry() })
  const order: string[] = []
  await host.load((api) => {
    api.on("session.end", () => void order.push("session.end"))
    api.onExit(() => void order.push("exit"))
  }, "ext:a")
  bus.emit("session.end", { reason: "exit" }, { sessionId: "s" })
  await host.runExitHandlers(1000)
  expect(order).toEqual(["session.end", "exit"])
})

test("tool renderer decorators build on the presenter below, which may change later", async () => {
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
  })
  await host.load(
    (api) =>
      void api.decorateToolRenderer("edit", (below) => ({
        ...below,
        summary: (args) => `${below?.summary?.(args) ?? "?"} +lint`,
      })),
    "ext:lint",
  )
  expect(host.renderers.get("edit")?.summary?.({})).toBe("? +lint")
  // A presenter registered below it afterwards (e.g. its built-in) is picked up.
  host.renderers.register("edit", { summary: () => "a.ts" })
  // Registered last, so it sits on top and wins; the decorator is below it now.
  expect(host.renderers.get("edit")?.summary?.({})).toBe("a.ts")
  const built = host.renderers.get("edit")
  expect(host.renderers.get("edit")).toBe(built!)
  host.unload("ext:lint")
  expect(host.renderers.get("edit")?.summary?.({})).toBe("a.ts")

  const base = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
  })
  await base.load((api) => void api.registerToolRenderer("write", { summary: () => "b.ts" }), "builtin")
  await base.load(
    (api) =>
      void api.decorateToolRenderer("write", (below) => ({
        ...below,
        result: () => "2 errors",
      })),
    "ext:lint",
  )
  expect(base.renderers.get("write")?.summary?.({})).toBe("b.ts")
  expect(base.renderers.get("write")?.result?.({} as never)).toBe("2 errors")
  // A decorator that throws is skipped.
  await base.load(
    (api) =>
      void api.decorateToolRenderer("write", () => {
        throw new Error("bad")
      }),
    "ext:bad",
  )
  expect(base.renderers.get("write")?.result?.({} as never)).toBe("2 errors")
})

test("openPipe starts a piped process whose events reach the extension", async () => {
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
  })
  let api: ExtensionAPI | undefined
  await host.load((a) => {
    api = a
  }, "ext:pipe")
  let out = ""
  const exit = Promise.withResolvers<number | null>()
  const pipe = api!.openPipe(
    [process.execPath, "-e", "process.stdin.on('data', (d) => process.stdout.write('got ' + d))"],
    {
      cwd: process.cwd(),
      onEvent: (e) => {
        if (e.type === "stdout") out += e.data
        if (e.type === "exit") exit.resolve(e.code)
        // A throwing handler does not stop later events.
        if (e.type === "spawned") throw new Error("ignored")
      },
    },
  )
  pipe.write("ping\n")
  const deadline = Date.now() + 30_000
  while (!out.includes("got ping") && Date.now() < deadline) await Bun.sleep(20)
  expect(out).toContain("got ping")
  pipe.close(2000)
  expect(await exit.promise).toBe(0)
  expect(() => api!.openPipe([], { cwd: process.cwd(), onEvent: () => {} })).toThrow()
}, 60_000)

test("terminal proxies follow binding, default to no-op and become inert on unload", async () => {
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
  })
  let api!: ExtensionAPI
  await host.load((a) => {
    api = a
  }, "terminal")
  const proxy = api.terminal
  proxy.setTitle("headless")
  proxy.setProgress("paused")
  proxy.bell()
  const seen: string[] = []
  const detach = host.bindTerminal({
    setTitle: (title) => seen.push(title),
    setProgress: (state) => seen.push(state),
    bell: () => seen.push("bell"),
  })
  expect(api.terminal).toBe(proxy)
  proxy.setTitle("live")
  proxy.setProgress("indeterminate")
  proxy.bell()
  expect(seen).toEqual(["live", "indeterminate", "bell"])
  detach()
  proxy.bell()
  host.bindTerminal({
    setTitle: (title) => seen.push(title),
    setProgress: () => {},
    bell: () => seen.push("late"),
  })
  host.unload("terminal")
  proxy.setTitle("unloaded")
  proxy.setProgress("paused")
  proxy.bell()
  expect(seen).toEqual(["live", "indeterminate", "bell"])
})

test("failed extension loads revoke retained terminal proxies", async () => {
  const host = new ExtensionHost({
    bus: new EventBus(),
    interceptors: new InterceptorRegistry(),
    tools: new ToolRegistry(),
  })
  let api!: ExtensionAPI
  let bells = 0
  host.bindTerminal({ setTitle: () => {}, setProgress: () => {}, bell: () => bells++ })
  expect(
    await host.load((a) => {
      api = a
      throw new Error("failed")
    }, "failed"),
  ).toBe(false)
  api.terminal.bell()
  expect(bells).toBe(0)
})
