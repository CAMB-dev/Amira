import { expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import os, { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative } from "node:path"
import { type AnyEvent, defineTool, type ExtensionAPI, textResult } from "@amira/api"
import { resetCommandWorker } from "@amira/proc"
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

async function withExtensionDataHost(
  run: (host: ExtensionHost, tools: ToolRegistry, home: string) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "amira-extension-data-"))
  const previous = process.env.AMIRA_HOME
  let host: ExtensionHost | undefined
  try {
    // Use a relative override when the temporary directory is on the same drive.
    process.env.AMIRA_HOME = relative(process.cwd(), home)
    const tools = new ToolRegistry()
    host = new ExtensionHost({ bus: new EventBus(), interceptors: new InterceptorRegistry(), tools })
    await run(host, tools, home)
  } finally {
    host?.unloadAll()
    if (previous === undefined) delete process.env.AMIRA_HOME
    else process.env.AMIRA_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

test("extensions that never read dataDir create no directories, even when registering tools", async () => {
  await withExtensionDataHost(async (host, tools, home) => {
    let api!: ExtensionAPI
    expect(
      await host.load((a) => {
        api = a
        a.registerTool(
          defineTool({
            name: "unused_data",
            description: "No persistent data",
            parameters: { type: "object" },
            execute: async () => textResult("ok"),
          }),
        )
      }, "ext:builtin-unused"),
    ).toBe(true)
    const owner = tools.getRegistration("unused_data")!.dataOwner!
    expect(existsSync(join(home, "extension-data"))).toBe(false)
    process.env.AMIRA_HOME = join(home, "changed-before-access")
    expect(api.dataDir).toBe(owner.dataDir)
    expect(statSync(owner.dataDir).isDirectory()).toBe(true)
    expect(existsSync(process.env.AMIRA_HOME)).toBe(false)
  })
})

test("first dataDir access checks the namespace before and after mkdir, and failures can retry", async () => {
  await withExtensionDataHost(async (host, _tools, home) => {
    let api!: ExtensionAPI
    expect(
      await host.load((a) => {
        api = a
      }, "ext:lazy-checks"),
    ).toBe(true)
    const namespace = join(home, "extension-data")
    writeFileSync(namespace, "not a directory")
    expect(() => api.dataDir).toThrow("safely resolve")
    rmSync(namespace)
    const mkdir = fs.mkdirSync
    const redirected = spyOn(fs, "mkdirSync").mockImplementation((dir, opts) => {
      const result = mkdir(dir, opts)
      rmSync(String(dir), { recursive: true })
      writeFileSync(String(dir), "replaced during creation")
      return result
    })
    try {
      expect(() => api.dataDir).toThrow("safely resolve")
      expect(redirected).toHaveBeenCalledTimes(1)
    } finally {
      redirected.mockRestore()
    }
    rmSync(namespace, { recursive: true })
    expect(statSync(api.dataDir).isDirectory()).toBe(true)
  })
})

test("each extension interface captures home once, with absolute data directories under AMIRA_HOME", async () => {
  await withExtensionDataHost(async (host, tools, home) => {
    const apis: ExtensionAPI[] = []
    const tool = defineTool({
      name: "owned",
      description: "An extension-owned tool",
      parameters: { type: "object" },
      execute: async () => textResult("ok"),
    })
    expect(
      await host.load((api) => {
        apis.push(api)
        expect(api.home).toBe(home)
        expect(isAbsolute(api.dataDir)).toBe(true)
        expect(dirname(api.dataDir)).toBe(join(home, "extension-data"))
        expect(statSync(api.dataDir).isDirectory()).toBe(true)
        process.env.AMIRA_HOME = join(home, "changed-during-load")
        api.registerTool(tool)
      }, "ext:owned"),
    ).toBe(true)
    expect(tools.getRegistration("owned")).toEqual({
      tool,
      source: "ext:owned",
      dataOwner: { home, dataDir: apis[0]!.dataDir },
    })
    const nextHome = join(home, "changed-again")
    process.env.AMIRA_HOME = nextHome
    expect(await host.load((api) => void apis.push(api), "ext:other")).toBe(true)
    expect(apis[1]!.home).toBe(nextHome)
    expect(dirname(apis[1]!.dataDir)).toBe(join(nextHome, "extension-data"))
    expect(apis[1]!.dataDir).not.toBe(apis[0]!.dataDir)
    expect(apis[0]!.home).toBe(home)
    expect(tools.getRegistration("owned")?.dataOwner?.home).toBe(home)
  })
})

test("extension data directories default to ~/.amira when AMIRA_HOME is unset", async () => {
  const dir = mkdtempSync(join(tmpdir(), "amira-extension-default-home-"))
  const previous = process.env.AMIRA_HOME
  const homedir = spyOn(os, "homedir").mockReturnValue(dir)
  let host: ExtensionHost | undefined
  try {
    delete process.env.AMIRA_HOME
    host = new ExtensionHost({
      bus: new EventBus(),
      interceptors: new InterceptorRegistry(),
      tools: new ToolRegistry(),
    })
    let api!: ExtensionAPI
    expect(
      await host.load((a) => {
        api = a
      }, "ext:default-home"),
    ).toBe(true)
    expect(api.home).toBe(join(dir, ".amira"))
    expect(isAbsolute(api.dataDir)).toBe(true)
    expect(dirname(api.dataDir)).toBe(join(dir, ".amira", "extension-data"))
    expect(statSync(api.dataDir).isDirectory()).toBe(true)
  } finally {
    host?.unloadAll()
    homedir.mockRestore()
    if (previous === undefined) delete process.env.AMIRA_HOME
    else process.env.AMIRA_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test("extension identities produce safe bounded slugs and full case-sensitive identity hashes", async () => {
  await withExtensionDataHost(async (host, _tools, home) => {
    const identities = [
      "@scope/package",
      join(home, "nested", "extension.ts"),
      "C:\\extensions\\tool.ts",
      "../../outside",
      "CON",
      "NUL.",
      '\u0000\u0001\r\n\t<>:"|?*',
      "a/b",
      "a:b",
      "a_b",
      "a-b",
      "Case",
      "case",
      "a".repeat(200),
      `${"a".repeat(200)}b`,
      "工具🚀",
      "\uFFFD",
      "",
    ]
    const paths: string[] = []
    for (const [index, identity] of identities.entries()) {
      let api!: ExtensionAPI
      const source = `ext:identity-${index}`
      expect(
        await host.load(
          (a) => {
            api = a
          },
          source,
          identity,
        ),
      ).toBe(true)
      const hash = createHash("sha256").update(identity).digest("hex")
      expect(isAbsolute(api.dataDir)).toBe(true)
      expect(dirname(api.dataDir)).toBe(join(home, "extension-data"))
      expect(basename(api.dataDir)).toMatch(new RegExp(`^ext-[a-z0-9_-]{1,48}-${hash}$`))
      expect(statSync(api.dataDir).isDirectory()).toBe(true)
      paths.push(api.dataDir)
      expect(host.unload(source)).toBe(true)
      let reloaded!: ExtensionAPI
      expect(
        await host.load(
          (a) => {
            reloaded = a
          },
          source,
          identity,
        ),
      ).toBe(true)
      expect(reloaded.dataDir).toBe(api.dataDir)
    }
    expect(new Set(paths).size).toBe(identities.length)
  })
})

test("malformed Unicode host identities fail before the extension entry point", async () => {
  await withExtensionDataHost(async (host) => {
    let called = false
    for (const identity of ["\uD800", "\uD801"]) {
      expect(
        await host.load(
          () => {
            called = true
          },
          "ext:malformed",
          identity,
        ),
      ).toBe(false)
    }
    expect(called).toBe(false)
    expect(host.loaded).toEqual([])
  })
})

test("extension data survives unload and reload while tool ownership is removed and restored", async () => {
  await withExtensionDataHost(async (host, tools, home) => {
    const tool = defineTool({
      name: "persistent",
      description: "A tool with persistent extension data",
      parameters: { type: "object" },
      execute: async () => textResult("ok"),
    })
    let first!: ExtensionAPI
    expect(
      await host.load((api) => {
        first = api
        api.registerTool(tool)
        writeFileSync(join(api.dataDir, "state.json"), '{"count":1}')
      }, "ext:persistent"),
    ).toBe(true)
    const hash = createHash("sha256").update("ext:persistent").digest("hex")
    expect(basename(first.dataDir).endsWith(`-${hash}`)).toBe(true)
    expect(host.unload("ext:persistent")).toBe(true)
    expect(tools.get("persistent")).toBeUndefined()
    expect(tools.getRegistration("persistent")).toBeUndefined()
    expect(existsSync(first.dataDir)).toBe(true)
    let second!: ExtensionAPI
    expect(
      await host.load((api) => {
        second = api
        expect(readFileSync(join(api.dataDir, "state.json"), "utf8")).toBe('{"count":1}')
        api.registerTool(tool)
      }, "ext:persistent"),
    ).toBe(true)
    expect(second.dataDir).toBe(first.dataDir)
    expect(tools.getRegistration("persistent")?.dataOwner).toEqual({ home, dataDir: first.dataDir })
    expect(host.unload("ext:persistent")).toBe(true)
    rmSync(first.dataDir, { recursive: true })
    let apiAfterReset!: ExtensionAPI
    expect(
      await host.load((a) => {
        apiAfterReset = a
      }, "ext:persistent"),
    ).toBe(true)
    expect(apiAfterReset.dataDir).toBe(first.dataDir)
    expect(statSync(first.dataDir).isDirectory()).toBe(true)
    expect(existsSync(join(first.dataDir, "state.json"))).toBe(false)
  })
})

test("an unusable data namespace prevents the entry point from registering anything", async () => {
  await withExtensionDataHost(async (host, tools, home) => {
    writeFileSync(join(home, "extension-data"), "not a directory")
    let called = false
    expect(
      await host.load(() => {
        called = true
      }, "ext:blocked-data"),
    ).toBe(false)
    expect(called).toBe(false)
    expect(host.loaded).toEqual([])
    expect(tools.all()).toEqual([])
  })
})

test("failed loads roll back owned tool registrations but preserve their data directory", async () => {
  await withExtensionDataHost(async (host, tools) => {
    const tool = defineTool({
      name: "rollback",
      description: "A tool whose extension fails to load",
      parameters: { type: "object" },
      override: true,
      execute: async () => textResult("ok"),
    })
    tools.register(tool, "core")
    let api!: ExtensionAPI
    expect(
      await host.load((a) => {
        api = a
        a.registerTool(tool)
        a.registerTool({ ...tool, name: "failed-only" })
        expect(tools.getRegistration("rollback")?.dataOwner?.dataDir).toBe(a.dataDir)
        writeFileSync(join(a.dataDir, "retained.txt"), "retained")
        throw new Error("failed after registering")
      }, "ext:rollback"),
    ).toBe(false)
    expect(host.loaded).not.toContain("ext:rollback")
    expect(tools.get("rollback")).toBe(tool)
    expect(tools.getRegistration("rollback")).toEqual({ tool, source: "core" })
    expect(tools.get("failed-only")).toBeUndefined()
    expect(tools.getRegistration("failed-only")).toBeUndefined()
    expect(tools.has("failed-only")).toBe(false)
    expect(readFileSync(join(api.dataDir, "retained.txt"), "utf8")).toBe("retained")
    expect(await host.load((a) => void a.registerTool(tool), "ext:rollback")).toBe(true)
    expect(tools.getRegistration("rollback")?.dataOwner?.dataDir).toBe(api.dataDir)
  })
})

test("host package names share data across sources, including loadFile labels", async () => {
  await withExtensionDataHost(async (host, tools, home) => {
    const identity = "@scope/shared-package"
    let api!: ExtensionAPI
    expect(
      await host.load(
        (a) => {
          api = a
        },
        "package:direct",
        identity,
      ),
    ).toBe(true)
    const file = join(home, "extension.ts")
    writeFileSync(
      file,
      [
        "export default (api) => {",
        '  api.registerTool({ name: "package_tool", description: "package tool",',
        '    parameters: { type: "object" }, execute: async () => ({ content: [] }) })',
        "}",
      ].join("\n"),
    )
    for (const source of ["package:user", "package:project"]) {
      expect(await host.loadFile(file, { source, name: identity })).toBe(true)
      expect(tools.getRegistration("package_tool")).toMatchObject({
        source,
        dataOwner: { home, dataDir: api.dataDir },
      })
      expect(host.unload(source)).toBe(true)
      expect(tools.getRegistration("package_tool")).toBeUndefined()
    }
    // Without an explicit host name, use the absolute file identity, not a display label or basename.
    expect(await host.loadFile(file, { source: "package:unlabelled" })).toBe(true)
    const owner = tools.getRegistration("package_tool")!.dataOwner!
    const hash = createHash("sha256")
      .update(process.platform === "win32" ? file.toLowerCase() : file)
      .digest("hex")
    expect(basename(owner.dataDir).endsWith(`-${hash}`)).toBe(true)
    expect(owner.dataDir).not.toBe(api.dataDir)
  })
})

test.skipIf(process.platform !== "win32")(
  "file data identities ignore Windows drive and path case",
  async () => {
    await withExtensionDataHost(async (host, tools, home) => {
      const file = join(home, "CaseExtension.ts")
      writeFileSync(
        file,
        'export default (api) => api.registerTool({ name: "case_file", description: "", parameters: { type: "object" }, execute: async () => ({ content: [] }) })',
      )
      expect(await host.loadFile(file, { source: "file:first" })).toBe(true)
      const first = tools.getRegistration("case_file")!.dataOwner!.dataDir
      host.unload("file:first")
      expect(await host.loadFile(file.toUpperCase(), { source: "file:second" })).toBe(true)
      expect(tools.getRegistration("case_file")!.dataOwner!.dataDir).toBe(first)
    })
  },
)

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

for (const mode of ["interleaved", "stdoutOnly", ...(process.platform === "win32" ? ["viaCmd"] : [])]) {
  test(`runCommand streams incremental git stdout before git exits (${mode})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "amira-git-stream-"))
    const script = join(dir, "stream.ts")
    const acknowledgements = [join(dir, "one.ack"), join(dir, "two.ack")]
    // Each piece must reach onChunk before git can produce the next one or exit. A sleep
    // alone would let a callback delivered after child exit (but before promise resolution) pass.
    writeFileSync(
      script,
      [
        'import { existsSync } from "node:fs"',
        `const acknowledgements = ${JSON.stringify(acknowledgements)}`,
        'for (const [i, text] of ["one\\n", "two\\n"].entries()) {',
        "  await Bun.write(Bun.stdout, text)",
        "  const deadline = performance.now() + 15_000",
        "  while (!existsSync(acknowledgements[i]!)) {",
        "    if (performance.now() >= deadline) process.exit(7)",
        "    await Bun.sleep(10)",
        "  }",
        "}",
        'await Bun.write(Bun.stdout, "done\\n")',
      ].join("\n"),
    )
    const host = new ExtensionHost({
      bus: new EventBus(),
      interceptors: new InterceptorRegistry(),
      tools: new ToolRegistry(),
      cwd: dir,
    })
    let api: ExtensionAPI | undefined
    await host.load((a) => {
      api = a
    }, "ext:git-stream")
    const quote = (s: string) => `'${s.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`
    const chunks: string[] = []
    let output = ""
    resetCommandWorker()
    // The real worker has its own Bun globals. If it cannot load, the inline fallback must
    // fail instead of silently turning this into a main-thread stdout test.
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("git streaming must run in the actual command worker")
    })
    try {
      const run = await api!.runCommand(
        ["git", "-c", `alias.amira-stream=!${quote(process.execPath)} ${quote(script)}`, "amira-stream"],
        {
          cwd: dir,
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          },
          timeoutMs: 30_000,
          signal: new AbortController().signal,
          stdoutOnly: mode === "stdoutOnly",
          viaCmd: mode === "viaCmd",
          onChunk: (chunk) => {
            chunks.push(chunk)
            output += chunk
            for (const [i, text] of ["one\n", "two\n"].entries()) {
              if (output.includes(text)) writeFileSync(acknowledgements[i]!, "received")
            }
          },
        },
      )
      expect(spawn).not.toHaveBeenCalled()
      expect(run).toMatchObject({
        output: "one\ntwo\ndone\n",
        exitCode: 0,
        timedOut: false,
        aborted: false,
        settled: true,
      })
      expect(chunks.join("")).toBe(run.output)
      expect(chunks.length).toBeGreaterThanOrEqual(3)
    } finally {
      spawn.mockRestore()
      resetCommandWorker()
      host.unload("ext:git-stream")
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
}

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
