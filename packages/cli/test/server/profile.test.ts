import "./offline.ts"
import { afterAll, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { parseCliArgs } from "../../src/args.ts"
import { resolveConfig } from "../../src/config.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import { createServerRuntime, serverMain } from "../../src/server-main.ts"
import { planPackages } from "../../src/trust.ts"

const root = mkdtempSync(path.join(os.tmpdir(), "amira-server-profile-"))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }))

test("server entry bundles without TUI, local builtin profile, terminal-status or theme assets", async () => {
  const result = await Bun.build({
    entrypoints: [path.resolve(import.meta.dir, "../../src/server-main.ts")],
    target: "bun",
    sourcemap: "external",
  })
  expect(result.success).toBe(true)
  const map = result.outputs.find((output) => output.path.endsWith(".map"))!
  const sources = (JSON.parse(await map.text()).sources as string[]).join("\n").replaceAll("\\", "/")
  expect(sources).not.toMatch(/packages\/tui(?:-kit)?\//)
  expect(sources).not.toContain("terminal-status")
  expect(sources).not.toContain("theme-files")
  expect(sources).not.toContain("builtin-profiles")
  expect(sources).not.toMatch(/themes\/.*\.json/)
})

test("server config resolves remote authority and permissions without reading auth", () => {
  const home = path.join(root, "remote-home")
  const cwd = path.join(root, "workspace")
  mkdirSync(home)
  mkdirSync(path.join(cwd, ".amira"), { recursive: true })
  writeFileSync(path.join(home, "settings.json"), JSON.stringify({ model: "remote/model", thinking: "high" }))
  writeFileSync(path.join(home, "auth.json"), "invalid auth that must not be read")
  writeFileSync(
    path.join(cwd, ".amira", "settings.json"),
    JSON.stringify({
      model: "project/model",
      permissions: { mode: "auto", rules: [{ command: ["bash"], decision: "allow" }] },
      packages: { trustedProjects: [cwd] },
    }),
  )
  const config = resolveConfig(parseCliArgs(["--cwd", cwd]), home, process.platform, { credentials: "omit" })
  expect(config.settings.model).toBe("project/model")
  expect(config.settings.thinking).toBe("high")
  expect(config.apiKeys).toEqual({})
  expect(config.warnings.join("\n")).not.toContain("auth.json")
  expect(config.permissions.rules.filter((rule) => rule.decision === "allow")).toEqual([])
})

test("package skill metadata respects remote project trust without executing its extensions", async () => {
  const home = path.join(root, "trust-home")
  const cwd = path.join(root, "trust-workspace")
  const pkg = path.join(cwd, ".amira", "packages", "project-skill")
  mkdirSync(home)
  mkdirSync(path.join(pkg, "skills"), { recursive: true })
  writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "project-skill",
      version: "1.0.0",
      amira: { extensions: ["index.ts"], skills: ["skills"] },
    }),
  )
  writeFileSync(path.join(pkg, "index.ts"), "throw new Error('must never execute')")
  writeFileSync(
    path.join(cwd, ".amira", "packages.lock"),
    JSON.stringify({
      lockfileVersion: 1,
      packages: {
        "project-skill": {
          version: "1.0.0",
          source: { type: "path", path: pkg },
          pinned: {},
          installedAt: new Date().toISOString(),
        },
      },
    }),
  )
  writeFileSync(
    path.join(cwd, ".amira", "settings.json"),
    JSON.stringify({ packages: { trustedProjects: [cwd] } }),
  )
  const config = resolveConfig(parseCliArgs(["--cwd", cwd]), home, process.platform, { credentials: "omit" })
  const untrusted = (await planPackages({ cwd, home, settings: config.settings })).packages()
  expect(untrusted.packages).toEqual([])
  expect(untrusted.skipped).toContainEqual({ name: "project-skill", scope: "project", why: "untrusted" })
  const trusted = (
    await planPackages({ cwd, home, settings: { packages: { trustedProjects: [cwd] } } })
  ).packages()
  expect(trusted.packages[0]!.manifest.skills).toEqual([path.join(pkg, "skills")])
})

test("default server builtins execute read and expose semantic status without terminal output", async () => {
  const file = path.join(root, "fixture.txt")
  writeFileSync(file, "server execution capability")
  const ai = createAi({
    dialects: [
      createMockDialect([{ toolCalls: [{ name: "read", args: { path: file } }] }, { text: "read complete" }]),
    ],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "", apiKey: "test" }],
  })
  const runtime = await createWorkspaceRuntime({
    cwd: root,
    ai,
    model: "mock/test",
    autoTitle: false,
    settings: { tui: { theme: "unavailable" } },
  })
  try {
    const attachment = runtime.attach()
    const status = await attachment.request("status.read", {})
    expect(status.items.length).toBeGreaterThan(0)
    expect(status.items.some((item) => item.text.includes("test"))).toBe(true)
    expect(JSON.stringify(status.items)).not.toContain("\u001b")
    expect((await attachment.execute("command.run", { line: "/provider" })).ok).toBe(false)
    expect((await attachment.execute("command.run", { line: "/ext" })).ok).toBe(false)
    const ended = new Promise<void>((resolve) => {
      const off = attachment.subscribeEvents((event) => {
        if (event.type === "turn.end") {
          off()
          resolve()
        }
      })
    })
    await attachment.execute("turn.prompt", { message: "read fixture" })
    await ended
    expect(JSON.stringify(attachment.snapshot.transcript)).toContain("server execution capability")
    const quit: unknown[] = []
    await attachment.detach()
    const next = runtime.attach({
      onEffect: (effect) => {
        quit.push(effect)
      },
    })
    expect((await next.execute("command.run", { line: "/quit" })).ok).toBe(true)
    expect(quit).toEqual([{ kind: "detach" }])
  } finally {
    await runtime.stop()
  }
})

test("configured entry uses remote settings/instructions and emits no terminal output", async () => {
  const remote = path.join(root, "entry-remote")
  const local = path.join(root, "entry-local")
  const cwd = path.join(root, "entry-workspace")
  for (const dir of [remote, local, cwd]) mkdirSync(dir)
  writeFileSync(
    path.join(remote, "settings.json"),
    JSON.stringify({ model: "mock/remote", sessions: { autoTitle: false }, tui: { theme: "missing" } }),
  )
  writeFileSync(path.join(remote, "auth.json"), "must not be read")
  writeFileSync(path.join(remote, "AGENTS.md"), "REMOTE_INSTRUCTIONS")
  writeFileSync(path.join(local, "settings.json"), JSON.stringify({ model: "mock/local" }))
  writeFileSync(path.join(local, "AGENTS.md"), "LOCAL_INSTRUCTIONS_MUST_NOT_LEAK")
  const previous = process.env.AMIRA_HOME
  const previousHome = process.env.HOME
  process.env.AMIRA_HOME = remote
  process.env.HOME = local
  const dialect = createMockDialect([{ text: "configured" }])
  const ai = createAi({ dialects: [dialect], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] })
  const writes: string[] = []
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk))
    return true
  })
  let runtime: Awaited<ReturnType<typeof createServerRuntime>> | undefined
  try {
    runtime = await createServerRuntime({ cwd, ai })
    const attachment = runtime.attach()
    expect(attachment.snapshot.state.model.id).toBe("remote")
    const ended = new Promise<void>((resolve) => {
      const off = attachment.subscribeEvents((event) => {
        if (event.type === "turn.end") {
          off()
          resolve()
        }
      })
    })
    await attachment.execute("turn.prompt", { message: "hello" })
    await ended
    expect(dialect.requests[0]!.systemPrompt).toContain("REMOTE_INSTRUCTIONS")
    expect(dialect.requests[0]!.systemPrompt).not.toContain("LOCAL_INSTRUCTIONS_MUST_NOT_LEAK")
    expect(writes).toEqual([])
  } finally {
    await runtime?.stop()
    stdout.mockRestore()
    if (previous === undefined) delete process.env.AMIRA_HOME
    else process.env.AMIRA_HOME = previous
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
  }
})

test("daemon restart restores saved history with a fresh epoch and no invented work", async () => {
  const cwd = path.join(root, "restart-workspace")
  mkdirSync(path.join(cwd, ".amira"), { recursive: true })
  writeFileSync(
    path.join(cwd, ".amira", "settings.json"),
    JSON.stringify({ model: "mock/m", sessions: { autoTitle: false } }),
  )
  const ai = createAi({
    dialects: [createMockDialect([{ text: "saved before restart" }])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const first = await createServerRuntime({ cwd, ai })
  let next: Awaited<ReturnType<typeof createServerRuntime>> | undefined
  try {
    const port = first.attach()
    const sessionId = port.snapshot.state.sessionId
    const ended = new Promise<void>((resolve) => {
      const off = port.subscribeEvents((event) => {
        if (event.type === "turn.end") {
          off()
          resolve()
        }
      })
    })
    await port.execute("turn.prompt", { message: "persist" })
    await ended
    await first.stop()
    next = await createServerRuntime({ cwd, ai })
    const restored = next.attach()
    expect(restored.snapshot.state.sessionId).toBe(sessionId)
    expect(JSON.stringify(restored.snapshot.transcript)).toContain("saved before restart")
    expect(next.journal.daemonEpoch).not.toBe(first.journal.daemonEpoch)
    expect(restored.pendingRequests).toEqual([])
    await restored.detach()
    expect(next.quiescent()).toBe(true)
  } finally {
    await first.stop()
    await next?.stop()
  }
})

test("executable probes are settings-free and write only their declared result", async () => {
  // The subprocess runs under the launcher's isolated home and inherits no live-provider opt-ins.
  const entry = path.resolve(import.meta.dir, "../../src/server-main.ts")
  for (const flag of ["--version", "--version-json", "--self-check"]) {
    const child = Bun.spawn([process.execPath, entry, flag], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code).toBe(0)
      expect(err).toBe("")
      expect(out.trim().split("\n").length).toBe(1)
      expect(out).not.toContain("\u001b")
      if (flag === "--self-check") expect(JSON.parse(out)).toMatchObject({ ok: true, daemon: false })
    } finally {
      child.kill()
    }
  }
  expect(typeof serverMain).toBe("function")
})
