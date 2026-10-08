import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { FormSpec } from "@amira/api"
import { UsageError } from "../src/args.ts"
import { lineDialogs, runProviderAdminCommand } from "../src/provider-cli.ts"

let home: string
let cwd: string
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "amira-pcli-"))
  cwd = path.join(home, "work")
  mkdirSync(cwd)
  mkdirSync(path.join(home, "cache"))
  writeFileSync(
    path.join(home, "cache", "models.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      data: {
        deepseek: {
          id: "deepseek",
          name: "DeepSeek",
          env: ["DEEPSEEK_API_KEY"],
          npm: "@ai-sdk/openai-compatible",
          api: "https://api.deepseek.com",
          models: {},
        },
        google: {
          id: "google",
          name: "Google",
          env: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
          npm: "@ai-sdk/google",
          models: {},
        },
        unusual: {
          id: "unusual",
          name: "Unusual",
          env: ["UNUSUAL_KEY"],
          npm: "@vendor/unknown",
          api: "https://unknown.example",
          models: {},
        },
      },
    }),
  )
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const KEY = "sk-cli-typed-12345678"

function io() {
  const out = { stdout: "", stderr: "" }
  return {
    out,
    io: {
      stdout: (s: string) => {
        out.stdout += s
      },
      stderr: (s: string) => {
        out.stderr += s
      },
    },
  }
}

/** Answers prompts in order; undefined is the end of input. */
const script = (answers: (string | undefined)[]) => async () => answers.shift()

const settings = () => JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8"))
const auth = () => JSON.parse(readFileSync(path.join(home, "auth.json"), "utf8"))

test("provider add from piped stdin asks field by field and saves", async () => {
  const { io: out, out: seen } = io()
  const code = await runProviderAdminCommand(["add"], {
    io: out,
    home,
    cwd,
    env: {},
    interactive: false,
    readLine: script([
      "custom", // vendor
      "", // protocol
      "ds-test", // id
      "", // dialect: the first, openai-chat
      "https://api.deepseek.com",
      "", // key: stored in auth.json
      KEY,
      "2", // Fetch models? No
      "2", // Models: Add values…
      "deepseek-chat deepseek-reasoner",
      "1", // Done
      "", // Defaults: no
      "", // Test connection? No
      "1", // Save
    ]),
  })
  expect(seen.stderr).toContain("Fetch models? Asks the provider")
  expect(seen.stderr).toContain("Test connection?")
  expect(code).toBe(0)
  expect(seen.stdout).toContain('Saved provider "ds-test"')
  expect(seen.stdout + seen.stderr).not.toContain(KEY)
  expect(settings().providers["ds-test"]).toMatchObject({
    dialect: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }],
  })
  expect(auth()).toEqual({ "ds-test": { type: "api_key", apiKey: KEY } })
})

test("provider edit shows the prefilled form; remove and key work without a session", async () => {
  writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify({
      model: "ds-test/deepseek-chat",
      providers: { "ds-test": { dialect: "openai-chat", baseUrl: "https://a", models: [{ id: "m1" }] } },
    }),
  )
  writeFileSync(path.join(home, "auth.json"), JSON.stringify({ "ds-test": { apiKey: KEY } }))
  let shown: FormSpec | undefined
  const edit = io()
  expect(
    await runProviderAdminCommand(["edit", "ds-test"], {
      io: edit.io,
      home,
      cwd,
      env: {},
      interactive: true,
      runForm: async (spec) => {
        shown = spec
        return {
          dialect: "openai-chat",
          baseUrl: "https://b",
          keySource: "auth",
          apiKey: "",
          models: ["m1", "m2"],
        }
      },
    }),
  ).toBe(0)
  expect(shown?.title).toBe("Edit provider ds-test")
  expect(settings().providers["ds-test"]).toMatchObject({
    baseUrl: "https://b",
    models: [{ id: "m1" }, { id: "m2" }],
  })
  expect(auth()["ds-test"].apiKey).toBe(KEY)

  const key = io()
  expect(
    await runProviderAdminCommand(["key", "ds-test"], {
      io: key.io,
      home,
      cwd,
      env: {},
      interactive: false,
      readLine: script(["sk-piped-in-87654321\n".trim()]),
    }),
  ).toBe(0)
  expect(key.out.stdout).toContain("…4321")
  expect(auth()["ds-test"].apiKey).toBe("sk-piped-in-87654321")

  const kept = io()
  expect(
    await runProviderAdminCommand(["remove", "ds-test"], {
      io: kept.io,
      home,
      cwd,
      env: {},
      interactive: false,
      readLine: script([""]),
    }),
  ).toBe(1)
  expect(settings().providers["ds-test"]).toBeDefined()

  const gone = io()
  expect(
    await runProviderAdminCommand(["remove", "ds-test", "--yes"], {
      io: gone.io,
      home,
      cwd,
      env: {},
      interactive: false,
    }),
  ).toBe(0)
  expect(gone.out.stdout).toContain('Removed provider "ds-test"')
  expect(gone.out.stdout).toContain("Deleted its key")
  expect(gone.out.stderr).toContain('"model" in settings.json (ds-test/deepseek-chat) uses this provider')
  expect(settings().providers).toEqual({})
  expect(auth()).toEqual({})
})

const noInput = async (): Promise<string | undefined> => {
  throw new Error("asked a question")
}

test("provider add <protocol> with every flag saves without asking anything", async () => {
  const { io: out, out: seen } = io()
  const code = await runProviderAdminCommand(
    [
      "add",
      "openai-chat",
      "--id",
      "ds",
      "--base-url=https://api.deepseek.com/",
      "--key-env",
      "DEEPSEEK_API_KEY",
      "--model",
      "deepseek-flash",
      "--model",
      "deepseek-pro",
      "--model",
      "deepseek-flash",
    ],
    { io: out, home, cwd, env: {}, interactive: false, readLine: noInput },
  )
  expect(seen.stderr).toBe("")
  expect(code).toBe(0)
  expect(seen.stdout).toContain('Saved provider "ds" (openai-chat, https://api.deepseek.com)')
  expect(seen.stdout).toContain("Key: read from $DEEPSEEK_API_KEY (not set now).")
  expect(settings().providers.ds).toEqual({
    dialect: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: [{ id: "deepseek-flash" }, { id: "deepseek-pro" }],
  })

  const local = io()
  expect(
    await runProviderAdminCommand(
      ["add", "anthropic-messages", "--id", "proxy", "--base-url", "http://localhost:4000", "--no-key"],
      { io: local.io, home, cwd, env: {}, interactive: false, readLine: noInput },
    ),
  ).toBe(0)
  expect(settings().providers.proxy).toEqual({
    dialect: "anthropic-messages",
    baseUrl: "http://localhost:4000",
  })
})

test("provider add --key-stdin stores the piped key in auth.json and never prints it", async () => {
  const { io: out, out: seen } = io()
  const code = await runProviderAdminCommand(
    ["add", "google-gemini", "--id", "g", "--base-url", "https://llm.example.com/v1beta", "--key-stdin"],
    { io: out, home, cwd, env: {}, interactive: false, readLine: script([` ${KEY} `]) },
  )
  expect(code).toBe(0)
  expect(auth()).toEqual({ g: { type: "api_key", apiKey: KEY } })
  expect(settings().providers.g).toEqual({
    dialect: "google-gemini",
    baseUrl: "https://llm.example.com/v1beta",
  })
  expect(seen.stdout + seen.stderr).not.toContain(KEY)
})

test("provider add with some flags opens the form with them filled in", async () => {
  let shown: FormSpec | undefined
  const { io: out } = io()
  const code = await runProviderAdminCommand(
    ["add", "anthropic-messages", "--id", "mine", "--key-env", "MY_KEY", "--model", "m1"],
    {
      io: out,
      home,
      cwd,
      env: {},
      interactive: true,
      runForm: async (spec) => {
        shown = spec
        return undefined
      },
    },
  )
  expect(code).toBe(1)
  const byId = Object.fromEntries(shown!.fields.map((f) => [f.id, f as unknown as Record<string, unknown>]))
  expect(shown!.title).toBe("Add a provider")
  expect(byId.id!.default).toBe("mine")
  expect(byId.dialect!.default).toBe("anthropic-messages")
  expect("default" in byId.baseUrl!).toBe(false)
  expect(byId.baseUrl!.placeholder).toBe("https://api.example.com/v1")
  expect(byId.keySource!.default).toBe("env")
  expect(byId.apiKeyEnv!.default).toBe("MY_KEY")
  expect(byId.models!.default).toEqual(["m1"])
})

test("provider add refuses unknown protocols, clashing flags and ids that exist", async () => {
  const { io: out } = io()
  const opts = { io: out, home, cwd, env: {}, interactive: false, readLine: noInput }
  const full = ["--id", "x", "--base-url", "http://x", "--no-key"]
  await expect(runProviderAdminCommand(["add", "not-a-vendor", ...full], opts)).rejects.toThrow(
    'unknown vendor or protocol "not-a-vendor"; protocols: openai-chat, openai-responses, anthropic-messages, google-gemini',
  )
  await expect(
    runProviderAdminCommand(["add", "openai-chat", ...full, "--key-env", "K"], opts),
  ).rejects.toThrow("pass one of --key-env, --key-stdin and --no-key")
  await expect(runProviderAdminCommand(["add", "openai-chat", "--key-stdin"], opts)).rejects.toThrow(
    "--key-stdin needs a supported vendor, or a protocol with --id and --base-url",
  )
  await expect(runProviderAdminCommand(["add", "--key-stdin"], opts)).rejects.toThrow(
    "--key-stdin needs a supported vendor, or a protocol with --id and --base-url",
  )
  await expect(runProviderAdminCommand(["add", "openai-chat", "--id"], opts)).rejects.toThrow(
    "--id needs a value",
  )
  await expect(runProviderAdminCommand(["add", "openai-chat", "--colour", "x"], opts)).rejects.toThrow(
    'unexpected "--colour"',
  )
  await expect(runProviderAdminCommand(["add", "a", "b"], opts)).rejects.toThrow('unexpected "b"')
  expect(await runProviderAdminCommand(["add", "openai-chat", ...full], opts)).toBe(0)
  await expect(runProviderAdminCommand(["add", "openai-chat", ...full], opts)).rejects.toThrow(
    'provider "x" exists already; change it with amira provider edit x',
  )
})

test("usage errors and subcommands left to the help command", async () => {
  const { io: out } = io()
  const opts = { io: out, home, cwd, env: {}, interactive: false, readLine: script([]) }
  expect(await runProviderAdminCommand(["presets"], opts)).toBeUndefined()
  expect(await runProviderAdminCommand(["help"], opts)).toBeUndefined()
  await expect(runProviderAdminCommand(["edit"], opts)).rejects.toThrow(UsageError)
  await expect(runProviderAdminCommand(["remove", "x", "--force"], opts)).rejects.toThrow(UsageError)
  await expect(runProviderAdminCommand(["edit", "nope"], opts)).rejects.toThrow('no provider "nope"')
})

test("line dialogs: numbers, the default, and retries", async () => {
  const { io: out, out: seen } = io()
  const d = lineDialogs(out, script(["9", "x", "2", ""]))
  expect(await d.select("Pick", ["a", "b"])).toBe("b")
  expect(seen.stderr).toContain("Type a number from 1 to 2.")
  expect(await d.input("Name", { initial: "keep" })).toBe("keep")
  expect(await d.input("More")).toBeUndefined()
})

test("vendor flags fill the endpoint and id without asking; renamed ids retain catalog facts", async () => {
  const { io: out, out: seen } = io()
  const opts = { io: out, home, cwd, env: {}, interactive: false, readLine: noInput }
  expect(await runProviderAdminCommand(["add", "deepseek", "--key-env", "DEEPSEEK_API_KEY"], opts)).toBe(0)
  expect(settings().providers.deepseek).toEqual({
    dialect: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  })
  expect(seen.stderr).toBe("")
  expect(
    await runProviderAdminCommand(
      ["add", "deepseek", "--id", "mine", "--base-url", "https://proxy.example/v1", "--no-key"],
      opts,
    ),
  ).toBe(0)
  expect(settings().providers.mine).toEqual({
    dialect: "openai-chat",
    baseUrl: "https://proxy.example/v1",
    catalogId: "deepseek",
  })
  expect(
    await runProviderAdminCommand(["add", "google", "--key-stdin"], {
      ...opts,
      readLine: script([KEY]),
    }),
  ).toBe(0)
  expect(auth()).toEqual({ google: { type: "api_key", apiKey: KEY } })
  expect(seen.stdout + seen.stderr).not.toContain(KEY)
})

test("the terminal starts with a filterable vendor list including Custom", async () => {
  const shown: FormSpec[] = []
  const { io: out } = io()
  expect(
    await runProviderAdminCommand(["add"], {
      io: out,
      home,
      cwd,
      env: {},
      interactive: true,
      runForm: async (spec) => {
        shown.push(spec)
        return shown.length === 1 ? { vendor: "deepseek" } : undefined
      },
    }),
  ).toBe(1)
  expect(shown[0]?.title).toBe("Choose a vendor")
  const list = shown[0]?.fields[0]
  if (list?.type !== "select") throw new Error("expected a filterable select")
  expect(list.options).toContainEqual({ value: "deepseek", label: "DeepSeek (deepseek)" })
  expect(list.options).toContainEqual({ value: "", label: "Custom (choose a protocol)" })
  expect(shown[1]?.title).toBe("Add a provider")
  expect(shown[1]?.fields.find((f) => f.id === "baseUrl")).toMatchObject({
    default: "https://api.deepseek.com",
  })
})

test("vendor forms suggest a free id and select only the name of a set environment variable", async () => {
  writeFileSync(
    path.join(home, "settings.json"),
    JSON.stringify({
      providers: { google: { dialect: "google-gemini", baseUrl: "https://existing.example/v1beta" } },
    }),
  )
  let shown: FormSpec | undefined
  const { io: out, out: seen } = io()
  expect(
    await runProviderAdminCommand(["add", "google"], {
      io: out,
      home,
      cwd,
      env: { GEMINI_API_KEY: KEY },
      interactive: true,
      runForm: async (spec) => {
        shown = spec
        return {
          id: "renamed-google",
          dialect: "google-gemini",
          baseUrl: "https://proxy.example/v1beta",
          keySource: "env",
          apiKeyEnv: "GEMINI_API_KEY",
          models: [],
        }
      },
    }),
  ).toBe(0)
  const fields = Object.fromEntries(shown!.fields.map((f) => [f.id, f]))
  expect(fields.id).toMatchObject({ default: "google-2" })
  expect(fields.dialect).toMatchObject({ default: "google-gemini" })
  expect(fields.baseUrl).toMatchObject({ default: "https://generativelanguage.googleapis.com/v1beta" })
  expect(fields.keySource).toMatchObject({ default: "env" })
  expect(fields.apiKeyEnv).toMatchObject({ default: "GEMINI_API_KEY" })
  expect(settings().providers["renamed-google"].catalogId).toBe("google")
  expect(JSON.stringify(shown) + seen.stdout + seen.stderr).not.toContain(KEY)
})

test("vendor picker supports piped ids and lists close matches before retrying", async () => {
  const { io: out, out: seen } = io()
  expect(
    await runProviderAdminCommand(["add"], {
      io: out,
      home,
      cwd,
      env: {},
      interactive: false,
      readLine: script([
        "deepsek",
        "deepseek", // vendor retry
        "",
        "",
        "", // prefilled id, protocol, endpoint
        "3", // no key
        "2", // no fetch
        "1", // models: done
        "",
        "",
        "1", // no defaults, no test, save
      ]),
    }),
  ).toBe(0)
  expect(seen.stderr).toContain("DeepSeek (deepseek)")
  expect(seen.stderr).toContain("Unusual (unusual) — pick the protocol yourself")
  expect(seen.stderr).toContain("Close matches: deepseek")
  expect(settings().providers.deepseek.baseUrl).toBe("https://api.deepseek.com")
})

test("unsupported vendor keeps id and key hints but asks for protocol and URL", async () => {
  let shown: FormSpec | undefined
  const { io: out } = io()
  expect(
    await runProviderAdminCommand(["add", "unusual"], {
      io: out,
      home,
      cwd,
      env: {},
      interactive: true,
      runForm: async (spec) => {
        shown = spec
        return undefined
      },
    }),
  ).toBe(1)
  const fields = Object.fromEntries(shown!.fields.map((f) => [f.id, f]))
  expect(fields.id).toMatchObject({ default: "unusual" })
  expect(fields.baseUrl).not.toHaveProperty("default")
  expect(fields.keySource).toMatchObject({ default: "auth" })
  expect(fields.apiKeyEnv).toMatchObject({ default: "UNUSUAL_KEY" })
})

test("an offline missing catalog falls straight into Custom with one note", async () => {
  rmSync(path.join(home, "cache"), { recursive: true })
  let calls = 0
  const { io: out, out: seen } = io()
  expect(
    await runProviderAdminCommand(["add"], {
      io: out,
      home,
      cwd,
      env: {},
      interactive: false,
      catalog: {
        fetch: (async () => {
          calls++
          throw new Error("offline")
        }) as unknown as typeof fetch,
      },
      readLine: script([undefined]),
    }),
  ).toBe(1)
  expect(calls).toBe(1)
  expect(seen.stderr).toContain("Vendor catalog unavailable; choose a custom provider.")
  expect(seen.stderr).toContain("Which protocol does the provider speak?")
  expect(seen.stderr).not.toContain("Choose a vendor")
})
