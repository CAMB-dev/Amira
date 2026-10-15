// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Catalog URL placeholders are literal fixtures.
import { afterEach, beforeEach, expect, setDefaultTimeout, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { type FormSpec, runFormDialogs } from "@amira/api"
import { UsageError } from "../src/args.ts"
import type { CatalogCacheOptions } from "../src/catalog.ts"
import { lineDialogs, runProviderAdminCommand } from "../src/provider-cli.ts"
import catalogFixture from "./fixtures/provider-catalog.json" with { type: "json" }

// A full add/edit dialog takes ~4s alone; a loaded machine exceeds the 5s default.
setDefaultTimeout(30_000)

let home: string
let cwd: string
let networkFetch: ReturnType<typeof spyOn<typeof globalThis, "fetch">>
beforeEach(() => {
  networkFetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        throw new Error("provider CLI tests must not access the network")
      },
      { preconnect: () => {} },
    ),
  )
  home = mkdtempSync(path.join(os.tmpdir(), "amira-pcli-"))
  cwd = path.join(home, "work")
  mkdirSync(cwd)
  mkdirSync(path.join(home, "cache"))
  writeFileSync(
    path.join(home, "cache", "models.json"),
    JSON.stringify({
      fetchedAt: Date.now(),
      data: catalogFixture,
    }),
  )
})
afterEach(() => {
  try {
    expect(networkFetch).not.toHaveBeenCalled()
  } finally {
    networkFetch.mockRestore()
    rmSync(home, { recursive: true, force: true })
  }
})

/** Both cache reads and refreshes stay in the temporary home and use the tiny fixture. */
const catalogOptions = (): CatalogCacheOptions => ({
  file: path.join(home, "cache", "models.json"),
  fetch: Object.assign(async () => Response.json(catalogFixture), { preconnect: () => {} }),
})

const KEY = "sk-cli-typed-12345678"
const probeFetch = Object.assign(
  async () =>
    Response.json({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }),
  { preconnect: () => {} },
)

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
    catalog: catalogOptions(),
    env: {},
    interactive: false,
    fetch: probeFetch,
    readLine: script([
      "", // Vendor: Custom
      "ds-test", // id
      "", // protocol
      "https://api.deepseek.com",
      "", // key source: auth.json
      KEY,
      "2", // no fetch
      "2", // Models: Add values…
      "deepseek-chat deepseek-reasoner",
      "1", // Done
      "", // no defaults
      "", // no advanced
      "2", // consent to potentially billed test
      "", // no manual test
      "1", // Save (automatic test)
    ]),
  })
  expect(seen.stderr).toContain("Fetch models?\n  1) Yes\n  2) No")
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
      catalog: catalogOptions(),
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
      catalog: catalogOptions(),
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
      catalog: catalogOptions(),
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
      catalog: catalogOptions(),
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
    { io: out, home, cwd, catalog: catalogOptions(), env: {}, interactive: false, readLine: noInput },
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
      { io: local.io, home, cwd, catalog: catalogOptions(), env: {}, interactive: false, readLine: noInput },
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
    {
      io: out,
      home,
      cwd,
      catalog: catalogOptions(),
      env: {},
      interactive: false,
      readLine: script([` ${KEY} `]),
    },
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
      catalog: catalogOptions(),
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
  const opts = {
    io: out,
    home,
    cwd,
    catalog: catalogOptions(),
    env: {},
    interactive: false,
    readLine: noInput,
  }
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
  const opts = {
    io: out,
    home,
    cwd,
    catalog: catalogOptions(),
    env: {},
    interactive: false,
    readLine: script([]),
  }
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
  const opts = {
    io: out,
    home,
    cwd,
    catalog: catalogOptions(),
    env: {},
    interactive: false,
    readLine: noInput,
  }
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

test.each([false, true])(
  "complete vendor flags refuse a duplicate id (terminal: %s)",
  async (interactive) => {
    const { io: out } = io()
    const opts = { io: out, home, cwd, catalog: catalogOptions(), env: {}, interactive, readLine: noInput }
    const args = ["add", "deepseek", "--key-env", "X"]
    expect(await runProviderAdminCommand(args, opts)).toBe(0)
    const before = readFileSync(path.join(home, "settings.json"), "utf8")
    await expect(runProviderAdminCommand(args, opts)).rejects.toThrow(
      'provider "deepseek" exists already; change it with amira provider edit deepseek',
    )
    expect(readFileSync(path.join(home, "settings.json"), "utf8")).toBe(before)
    expect(Object.keys(settings().providers)).toEqual(["deepseek"])
  },
)

test("line-by-line forms keep the suggested suffix for a duplicate vendor id", async () => {
  const { io: out } = io()
  const opts = { io: out, home, cwd, catalog: catalogOptions(), env: {}, interactive: false }
  expect(
    await runProviderAdminCommand(["add", "deepseek", "--key-env", "X"], {
      ...opts,
      readLine: noInput,
    }),
  ).toBe(0)
  expect(
    await runProviderAdminCommand(["add", "deepseek"], {
      ...opts,
      readLine: script(["", "", "", "", "3", "2", "1", "", "", "", "1"]),
    }),
  ).toBe(0)
  expect(Object.keys(settings().providers)).toEqual(["deepseek", "deepseek-2"])
  expect(settings().providers["deepseek-2"].catalogId).toBe("deepseek")
})

test("the terminal starts with a filterable vendor list including Custom", async () => {
  const shown: FormSpec[] = []
  const { io: out } = io()
  expect(
    await runProviderAdminCommand(["add"], {
      io: out,
      home,
      cwd,
      catalog: catalogOptions(),
      env: {},
      interactive: true,
      runForm: async (spec) => {
        shown.push(spec)
        return undefined
      },
    }),
  ).toBe(1)
  expect(shown[0]?.title).toBe("Add a provider")
  const list = shown[0]?.fields[0]
  if (list?.type !== "select") throw new Error("expected a filterable select")
  expect(list.options).toContainEqual(
    expect.objectContaining({ value: "deepseek", label: "DeepSeek (deepseek)", group: "Popular" }),
  )
  expect(list.options).toContainEqual(expect.objectContaining({ label: expect.stringContaining("Custom") }))
  expect(shown).toHaveLength(1)
  expect(shown[0]?.fields.find((f) => f.id === "dialect")).toMatchObject({ type: "select" })
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
      catalog: catalogOptions(),
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

test("piped setup chooses the vendor inside the form and shows a masked final preview", async () => {
  const { io: out, out: seen } = io()
  expect(
    await runProviderAdminCommand(["add"], {
      io: out,
      home,
      cwd,
      catalog: catalogOptions(),
      env: {},
      interactive: false,
      readLine: script([
        "Popular · DeepSeek (deepseek)",
        "",
        "",
        "", // vendor, ID, protocol, endpoint
        "3",
        "2",
        "1", // no key, no fetch, models done
        "",
        "",
        "",
        "1", // skip defaults/advanced/manual test, save
      ]),
    }),
  ).toBe(0)
  expect(seen.stderr).toContain("DeepSeek (deepseek)")
  expect(seen.stderr).toContain("settings.json")
  expect(seen.stderr).toContain("auth.json")
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
      catalog: catalogOptions(),
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

test("a missing catalog refreshes from the tiny fixture without network access", async () => {
  rmSync(path.join(home, "cache"), { recursive: true })
  const catalog = catalogOptions()
  const fetchFixture = catalog.fetch!
  let calls = 0
  const { io: out, out: seen } = io()
  let shown: FormSpec | undefined
  expect(
    await runProviderAdminCommand(["add", "deepseek"], {
      io: out,
      home,
      cwd,
      env: {},
      interactive: true,
      catalog: {
        ...catalog,
        fetch: (async (...args: Parameters<typeof fetch>) => {
          calls++
          return fetchFixture(...args)
        }) as typeof fetch,
      },
      runForm: async (spec) => {
        shown = spec
        return undefined
      },
    }),
  ).toBe(1)
  expect(calls).toBe(1)
  expect(shown?.fields.find((f) => f.id === "baseUrl")).toMatchObject({
    default: "https://api.deepseek.com",
  })
  expect(JSON.parse(readFileSync(catalog.file!, "utf8")).data).toEqual(catalogFixture)
  expect(seen.stderr).toContain("Loading vendors from models.dev…")
})

test("a missing catalog opens Custom without waiting for a network request", async () => {
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
        ...catalogOptions(),
        fetch: (async () => {
          calls++
          throw new Error("offline")
        }) as unknown as typeof fetch,
      },
      readLine: script([undefined]),
    }),
  ).toBe(1)
  expect(calls).toBe(0)
  expect(seen.stderr).toContain("Vendor")
  expect(seen.stderr).not.toContain("Loading vendors from models.dev…")
})

test.each([false, true])(
  "offline positional lookup explains an unavailable catalog (legacy: %s)",
  async (legacy) => {
    if (legacy) {
      writeFileSync(
        path.join(home, "cache", "models.json"),
        JSON.stringify({
          fetchedAt: Date.now(),
          data: { deepseek: { models: {} } },
        }),
      )
    } else {
      rmSync(path.join(home, "cache"), { recursive: true })
    }
    const { io: out, out: seen } = io()
    let calls = 0
    await expect(
      runProviderAdminCommand(["add", "deepseek"], {
        io: out,
        home,
        cwd,
        env: {},
        interactive: false,
        readLine: noInput,
        catalog: {
          ...catalogOptions(),
          fetch: (async () => {
            expect(seen.stderr).toBe("Loading vendors from models.dev…\n")
            calls++
            throw new Error("offline")
          }) as unknown as typeof fetch,
        },
      }),
    ).rejects.toThrow(
      'Vendor catalog unavailable (offline?); cannot look up "deepseek". Choose a protocol instead: openai-chat',
    )
    expect(calls).toBe(1)
    expect(seen.stdout).toBe("")
  },
)

test.each([
  [
    "cloudflare",
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    "CLOUDFLARE_ACCOUNT_ID",
  ],
  ["neon", "${NEON_AI_GATEWAY_BASE_URL}/v1", "NEON_AI_GATEWAY_BASE_URL"],
])(
  "%s URL placeholders prefill the form but need --base-url for complete flags",
  async (id, api, placeholder) => {
    writeFileSync(
      path.join(home, "cache", "models.json"),
      JSON.stringify({
        fetchedAt: Date.now(),
        data: { [id!]: { id, name: id, env: ["X"], npm: "@ai-sdk/openai-compatible", api, models: {} } },
      }),
    )
    const { io: out, out: seen } = io()
    const opts = {
      io: out,
      home,
      cwd,
      catalog: catalogOptions(),
      env: {},
      interactive: false,
      readLine: noInput,
    }
    await expect(runProviderAdminCommand(["add", id!, "--key-env", "X"], opts)).rejects.toThrow(
      "needs --base-url",
    )
    await expect(runProviderAdminCommand(["add", id!, "--key-stdin"], opts)).rejects.toThrow(
      "needs --base-url",
    )
    let shown: FormSpec | undefined
    expect(
      await runProviderAdminCommand(["add", id!], {
        ...opts,
        interactive: true,
        runForm: async (spec) => {
          shown = spec
          return undefined
        },
      }),
    ).toBe(1)
    expect(shown!.fields.find((f) => f.id === "baseUrl")).toMatchObject({ default: api })
    expect(shown!.fields.find((f) => f.id === "dialect")).toMatchObject({ default: "openai-chat" })
    expect(await runProviderAdminCommand(["add", id!, "--key-env", "X", "--base-url", api!], opts)).toBe(1)
    expect(seen.stderr).toContain(`replace \${${placeholder}} in the base URL with its value`)
    expect(
      await runProviderAdminCommand(
        ["add", id!, "--key-env", "X", "--base-url", "https://resolved.example/v1"],
        opts,
      ),
    ).toBe(0)
    expect(settings().providers[id!].baseUrl).toBe("https://resolved.example/v1")
  },
)

test("non-TTY textarea consumes multiple header lines before asking for fallbacks", async () => {
  const { io: output, out } = io()
  const values = await runFormDialogs(
    {
      title: "Advanced provider settings",
      fields: [
        { id: "headers", type: "textarea", label: "Request headers" },
        { id: "fallbacks", type: "text", label: "Fallback variables", pattern: "[A-Z_]+" },
      ],
    },
    lineDialogs(output, script(["X-One=1", "X-Two=2", ".", "BACKUP_KEY", "Save"])),
  )
  expect(values).toEqual({ headers: "X-One=1\nX-Two=2", fallbacks: "BACKUP_KEY" })
  expect(out.stderr).toContain("'.' alone")
})

test("line-mode multiline fields can keep, clear, escape dots, and cancel without consuming later answers", async () => {
  const { io: output } = io()
  expect(
    await lineDialogs(output, script(["."])).input("Headers", { multiline: true, initial: "X-Old=old" }),
  ).toBe("X-Old=old")
  expect(
    await lineDialogs(output, script(["", "."])).input("Headers", { multiline: true, initial: "X-Old=old" }),
  ).toBe("")
  expect(await lineDialogs(output, script(["..", "."])).input("Notes", { multiline: true })).toBe(".")
  expect(
    await lineDialogs(output, script(["X-One=1", undefined])).input("Headers", { multiline: true }),
  ).toBeUndefined()
})

test.each(["none", "env"] as const)(
  "non-TTY provider setup round-trips headers and fallback-only variables (%s)",
  async (source) => {
    const { io: output, out } = io()
    const code = await runProviderAdminCommand(["add", "openai-chat"], {
      io: output,
      home,
      cwd,
      catalog: catalogOptions(),
      env: { BACKUP_ONE: "fake-env-key" },
      interactive: false,
      readLine: script([
        "",
        "cli-advanced",
        "",
        "https://example.test/v1", // vendor, ID, protocol, URL
        source === "env" ? "2" : "3", // environment or no key
        ...(source === "env" ? [""] : []), // primary intentionally blank; Advanced supplies fallbacks
        "2",
        "1",
        "1",
        "2", // no fetch, models Done, defaults No, Advanced Yes
        "X-One=1",
        "X-Two=2",
        ".", // multiline request headers
        "BACKUP_ONE BACKUP_TWO",
        "1",
        "1",
        ".", // fallbacks, default compat, keep empty fast map
        "1",
        "1", // no manual test; confirm final preview
      ]),
    })
    expect(code).toBe(0)
    expect(settings().providers["cli-advanced"]).toMatchObject({
      keySource: source,
      headers: { "X-One": "1", "X-Two": "2" },
      apiKeyEnvFallbacks: ["BACKUP_ONE", "BACKUP_TWO"],
    })
    expect(settings().providers["cli-advanced"]).not.toHaveProperty("apiKeyEnv")
    expect(out.stderr).toContain("settings.json")
    expect(out.stderr).not.toContain("fake-env-key")
  },
)
