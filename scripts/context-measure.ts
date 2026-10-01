/**
 * Offline measurement of context management (A4): drives the real Agent with a scripted mock
 * model and the real read, grep, glob and output_read tools over a generated workspace, once
 * with the context features off ("before") and once with their defaults ("after"), and compares
 * what the requests carried. No network, no real model; everything lives under the OS temp dir.
 *
 *   bun scripts/context-measure.ts            tables
 *   bun scripts/context-measure.ts --json     JSON
 *   bun scripts/context-measure.ts --quick    smaller scenarios
 *
 * It shows request sizes, prefix stability and recovery reads. It cannot show real cache hits,
 * real bills or how well a model works with previews and stubs.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { globTool } from "../extensions/builtin-tools/src/glob.ts"
import { grepTool } from "../extensions/builtin-tools/src/grep.ts"
import { outputReadTool } from "../extensions/builtin-tools/src/output-read.ts"
import { readTool } from "../extensions/builtin-tools/src/read.ts"
import {
  createAi,
  createMockDialect,
  type Message,
  type MockReply,
  type ModelRequest,
} from "../packages/ai/src/index.ts"
import { ARTIFACT_HEADER, defineTool, textResult } from "../packages/api/src/index.ts"
import { Agent } from "../packages/core/src/agent.ts"
import type { CompactionOptions } from "../packages/core/src/compaction.ts"
import type { ContextOptions } from "../packages/core/src/context.ts"
import { SessionStore } from "../packages/core/src/session-store.ts"
import { ToolRegistry } from "../packages/core/src/tool-registry.ts"

export type ScenarioName = "long-session" | "repeated-reads" | "cjk" | "long-turn"
export const SCENARIOS: ScenarioName[] = ["long-session", "repeated-reads", "cjk", "long-turn"]
export type VariantName = "before" | "after" | "before+compact" | "after+compact"

const WINDOW = 128_000
/** Illustrative prices, USD per million tokens. */
const PRICE = { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 }
const OUTPUT_TOKENS = 50

const OFF: ContextOptions = {
  saveAbove: 10_000_000,
  previewChars: 10_000_000,
  dedupeReads: false,
  aging: { enabled: false },
}

/**
 * Tokens as a model would count them, roughly: four ASCII characters a token, one token for
 * any other character (CJK text is about that).
 */
export function modelTokens(text: string): number {
  let ascii = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++
    else other++
  }
  return Math.ceil(ascii / 4) + other
}

const messageText = (m: Message) => JSON.stringify(m)
const fixedTokens = (req: ModelRequest) =>
  modelTokens(req.systemPrompt) + modelTokens(JSON.stringify(req.tools))
const requestTokens = (req: ModelRequest) =>
  fixedTokens(req) + req.messages.reduce((n, m) => n + modelTokens(messageText(m)), 0)

// ---------- workspace and scripted model ----------

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CJK_WORDS = [
  "模块",
  "编译",
  "上下文",
  "缓存",
  "工具",
  "结果",
  "会话",
  "压缩",
  "读取",
  "文件",
  "错误",
  "警告",
]

function sourceFile(i: number, lines: number): string {
  const out: string[] = []
  for (let l = 0; l < lines; l++) {
    out.push(
      l % 17 === 0
        ? `// TODO(${i}-${l}): revisit this part of module ${i}`
        : `export function f${i}_${l}(x: number): number { return x * ${l} + ${i} }`,
    )
  }
  return `${out.join("\n")}\n`
}

function cjkDoc(i: number, lines: number, random: () => number): string {
  const out: string[] = []
  for (let l = 0; l < lines; l++) {
    const words = Array.from({ length: 12 }, () => CJK_WORDS[Math.floor(random() * CJK_WORDS.length)])
    out.push(`第${l + 1}行：文档${i}说明${words.join("")}。`)
  }
  return `${out.join("\n")}\n`
}

/** A build log of about `chars` characters, with CRLF line ends. */
function buildLog(chars: number, seed: number, cjk: boolean): string {
  const random = rng(seed)
  const out: string[] = []
  let size = 0
  for (let i = 0; size < chars; i++) {
    const level = random() < 0.03 ? "ERROR" : random() < 0.1 ? "WARN " : "INFO "
    const line = cjk
      ? `[12:00:${String(i % 60).padStart(2, "0")}] ${level} 正在编译模块 ${i % 300}，耗时 ${Math.floor(random() * 900)} 毫秒，${CJK_WORDS[i % CJK_WORDS.length]}已更新`
      : `[2026-10-01T12:00:${String(i % 60).padStart(2, "0")}Z] ${level} step ${i}: compiling src/mod${i % 300}.ts (${Math.floor(random() * 900)} ms)`
    out.push(line)
    size += line.length + 2
  }
  return `${out.join("\r\n")}\r\n\nExit code: ${out.some((l) => l.includes("ERROR")) ? 1 : 0}`
}

/** A tool named bash that prints a canned log, so the measurement runs on any OS. */
const fakeBash = defineTool<{ command: string; size?: number; cjk?: boolean; seed?: number }>({
  name: "bash",
  description: "Run a shell command (canned output for the measurement).",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      size: { type: "integer" },
      cjk: { type: "boolean" },
      seed: { type: "integer" },
    },
    required: ["command"],
  },
  concurrency: "parallel",
  execute: async (p) => textResult(buildLog(p.size ?? 2000, p.seed ?? 1, p.cjk === true)),
})

type Call = { name: string; args: Record<string, unknown>; id?: string }
/** One model step: tool calls, a recovery read of the latest artifact, or the final answer. */
type Action = { calls: Call[] } | { recover: true } | { final: string } | { write: [string, string] }
interface Scenario {
  /** Each prompt and the steps the model takes for it. */
  prompts: { text: string; steps: Action[] }[]
  setup(dir: string): void
  /** Ids of reads right after a file changed: they must never be sent as "unchanged". */
  mustNotDedupe?: string[]
}

function longSession(scale: number): Scenario {
  const random = rng(11)
  const files = 40
  const prompts: Scenario["prompts"] = []
  const turns = Math.max(4, Math.round(110 * scale))
  for (let t = 0; t < turns; t++) {
    const steps: Action[] = []
    const f = Math.floor(random() * files)
    steps.push({ calls: [{ name: "read", args: { path: `src/mod${f}.ts`, offset: 1, limit: 120 } }] })
    if (t % 3 === 0)
      steps.push({ calls: [{ name: "grep", args: { pattern: `f${f}_1\\d\\b`, path: "src" } }] })
    if (t % 10 === 5) {
      const size = 40_000 + Math.floor(random() * 80_000)
      steps.push({ calls: [{ name: "bash", args: { command: `bun test #${t}`, size, seed: t } }] })
    }
    if (t % 15 === 6) steps.push({ recover: true })
    steps.push({ final: `Done with step ${t}.` })
    prompts.push({ text: `Task ${t}: look at module ${f}.`, steps })
  }
  return {
    prompts,
    setup(dir) {
      mkdirSync(path.join(dir, "src"), { recursive: true })
      for (let i = 0; i < files; i++) writeFileSync(path.join(dir, "src", `mod${i}.ts`), sourceFile(i, 200))
    },
  }
}

function repeatedReads(scale: number): Scenario {
  const turns = Math.max(6, Math.round(30 * scale))
  const prompts: Scenario["prompts"] = []
  const mustNotDedupe: string[] = []
  const change = Math.floor(turns / 2)
  for (let t = 0; t < turns; t++) {
    const steps: Action[] = []
    if (t === change) steps.push({ write: ["src/mod0.ts", sourceFile(999, 200)] })
    const calls: Call[] = [0, 1, 2, 3, 4].map((f) => ({
      name: "read",
      args: { path: `src/mod${f}.ts`, offset: 1, limit: 150 },
      id: `r${t}_${f}`,
    }))
    if (t === change) mustNotDedupe.push(`r${t}_0`)
    steps.push({ calls })
    steps.push({ final: `Checked again (${t}).` })
    prompts.push({ text: `Check the first modules again (${t}).`, steps })
  }
  return {
    prompts,
    mustNotDedupe,
    setup(dir) {
      mkdirSync(path.join(dir, "src"), { recursive: true })
      for (let i = 0; i < 5; i++) writeFileSync(path.join(dir, "src", `mod${i}.ts`), sourceFile(i, 200))
    },
  }
}

function cjk(scale: number): Scenario {
  const random = rng(23)
  const turns = Math.max(4, Math.round(40 * scale))
  const prompts: Scenario["prompts"] = []
  for (let t = 0; t < turns; t++) {
    const steps: Action[] = [{ calls: [{ name: "read", args: { path: `docs/doc${t % 10}.md` } }] }]
    if (t % 4 === 1) {
      steps.push({
        calls: [{ name: "bash", args: { command: `构建 ${t}`, size: 50_000, cjk: true, seed: t } }],
      })
    }
    if (t % 8 === 2) steps.push({ recover: true })
    steps.push({ final: `完成第 ${t} 步。` })
    prompts.push({ text: `请阅读文档 ${t % 10} 并总结。`, steps })
  }
  return {
    prompts,
    setup(dir) {
      mkdirSync(path.join(dir, "docs"), { recursive: true })
      for (let i = 0; i < 10; i++) writeFileSync(path.join(dir, "docs", `doc${i}.md`), cjkDoc(i, 400, random))
    },
  }
}

function longTurn(scale: number): Scenario {
  const steps: Action[] = []
  const count = Math.max(10, Math.round(150 * scale))
  const tree = Math.max(200, Math.round(3000 * scale))
  for (let s = 0; s < count; s++) {
    if (s % 15 === 0) steps.push({ calls: [{ name: "glob", args: { pattern: "**/*.ts", path: "tree" } }] })
    else if (s % 15 === 7) {
      steps.push({
        calls: [{ name: "grep", args: { pattern: "TODO", path: "tree", output_mode: "content" } }],
      })
    } else if (s % 15 === 11) {
      steps.push({ calls: [{ name: "bash", args: { command: `make #${s}`, size: 60_000, seed: s } }] })
    } else if (s % 30 === 12) steps.push({ recover: true })
    else steps.push({ calls: [{ name: "read", args: { path: `tree/d${s % 20}/f${s}.ts` } }] })
  }
  steps.push({ final: "All done." })
  return {
    prompts: [{ text: "Refactor the whole tree.", steps }],
    setup(dir) {
      for (let i = 0; i < tree; i++) {
        const d = path.join(dir, "tree", `d${i % 20}`)
        mkdirSync(d, { recursive: true })
        writeFileSync(path.join(d, `f${i}.ts`), sourceFile(i, 18))
      }
    },
  }
}

const BUILD: Record<ScenarioName, (scale: number) => Scenario> = {
  "long-session": longSession,
  "repeated-reads": repeatedReads,
  cjk,
  "long-turn": longTurn,
}

/** The latest artifact id a tool result in the request names. */
function latestArtifact(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== "toolResult") continue
    for (const b of m.content) {
      const id = b.type === "text" ? ARTIFACT_HEADER.exec(b.text)?.[1] : undefined
      if (id) return id
    }
  }
  return undefined
}

// ---------- metrics ----------

export interface VariantResult {
  variant: VariantName
  requests: number
  summaryRequests: number
  peakTokens: number
  overWindow: number
  /** Sum over requests of request tokens. */
  area: number
  cacheRead: number
  cacheWrite: number
  outputTokens: number
  costCached: number
  costUncached: number
  outputReads: number
  artifacts: number
  artifactBytes: number
  duplicates: number
  aged: number
  agingRounds: number
  pairingErrors: number
  unexpectedChanges: number
  wronglyDeduped: number
  ms: number
}

export interface ScenarioResult {
  scenario: ScenarioName
  variants: VariantResult[]
}

/** Every call answered by exactly one result right after its reply, in every request. */
function pairingErrors(req: ModelRequest): number {
  let errors = 0
  const ms = req.messages
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i]!
    if (m.role === "toolResult") {
      // A result must follow its reply or another result.
      const prev = ms[i - 1]
      if (!prev || (prev.role !== "assistant" && prev.role !== "toolResult")) errors++
      continue
    }
    if (m.role !== "assistant") continue
    const ids = m.content.flatMap((b) => (b.type === "toolCall" ? [b.id] : []))
    const results: string[] = []
    for (let j = i + 1; j < ms.length && ms[j]!.role === "toolResult"; j++) {
      results.push((ms[j] as { toolCallId: string }).toolCallId)
    }
    if (ids.length !== results.length || ids.some((id) => results.filter((r) => r === id).length !== 1))
      errors++
  }
  return errors
}

const isStub = (text: string) => text.includes("Earlier tool result cleared from the context")

function analyse(requests: ModelRequest[], checkPrefix: boolean) {
  let peak = 0
  let overWindow = 0
  let area = 0
  let cacheRead = 0
  let cacheWrite = 0
  let pairing = 0
  let unexpected = 0
  let summaries = 0
  let prev: string[] | undefined
  for (const req of requests) {
    const tokens = requestTokens(req)
    if (req.tools.length === 0) {
      // A compaction summary request: paid, but outside the conversation's cache chain.
      summaries++
      cacheWrite += tokens
      continue
    }
    peak = Math.max(peak, tokens)
    if (tokens > WINDOW) overWindow++
    area += tokens
    pairing += pairingErrors(req)
    const cur = req.messages.map(messageText)
    let same = 0
    if (prev) while (same < prev.length && same < cur.length && prev[same] === cur[same]) same++
    if (prev && checkPrefix) {
      for (let i = same; i < Math.min(prev.length, cur.length); i++) {
        if (prev[i] !== cur[i] && !isStub(cur[i]!)) unexpected++
      }
    }
    const read = prev
      ? fixedTokens(req) + req.messages.slice(0, same).reduce((n, m) => n + modelTokens(messageText(m)), 0)
      : 0
    cacheRead += read
    cacheWrite += tokens - read
    prev = cur
  }
  return { peak, overWindow, area, cacheRead, cacheWrite, pairing, unexpected, summaries }
}

async function runVariant(name: ScenarioName, variant: VariantName, scale: number): Promise<VariantResult> {
  const started = performance.now()
  const scenario = BUILD[name](scale)
  const dir = mkdtempSync(path.join(os.tmpdir(), `amira-measure-${name}-`))
  try {
    const work = path.join(dir, "work")
    mkdirSync(work)
    scenario.setup(work)
    const after = variant.startsWith("after")
    const plan = scenario.prompts.flatMap((p) => p.steps)
    let cursor = 0
    const router = (req: ModelRequest): MockReply => {
      const usage = { input: requestTokens(req), output: OUTPUT_TOKENS }
      if (req.tools.length === 0) return { text: "Summary: the work so far, in short.", usage }
      for (;;) {
        const action = plan[cursor++]
        if (!action) return { text: "(out of script)", usage }
        if ("write" in action) {
          writeFileSync(path.join(work, action.write[0]), action.write[1])
          continue
        }
        if ("final" in action) return { text: action.final, usage }
        if ("recover" in action) {
          const id = after ? latestArtifact(req.messages) : undefined
          const call: Call = id
            ? { name: "output_read", args: { id, grep: "ERROR|错误" } }
            : { name: "read", args: { path: firstFile(work), limit: 5 } }
          return { toolCalls: [call], usage }
        }
        return { toolCalls: action.calls, usage }
      }
    }
    const mock = createMockDialect(Array.from({ length: plan.length * 2 + 50 }, () => router))
    const ai = createAi({
      dialects: [mock],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "", defaultModel: { contextWindow: WINDOW } }],
      retry: { retries: 0 },
    })
    const tools = new ToolRegistry()
    for (const t of [readTool, grepTool, globTool, outputReadTool, fakeBash]) tools.register(t, "measure")
    const compaction: CompactionOptions = variant.endsWith("+compact") ? {} : { auto: false }
    const agent = new Agent({
      ai,
      model: ai.model("mock/test"),
      cwd: work,
      systemPrompt: "You are a coding agent. Work in the given directory.",
      session: SessionStore.create({ cwd: work, dir: path.join(dir, "sessions") }),
      tools,
      compaction,
      ...(after ? {} : { context: OFF }),
    })
    let agingRounds = 0
    agent.bus.subscribe((e) => {
      if (e.type === "extension.notice" && (e.data as { source?: string }).source === "context") agingRounds++
    })
    for (const p of scenario.prompts) {
      const r = await agent.prompt(p.text)
      if (r.reason !== "done") throw new Error(`${name}/${variant}: turn ended ${r.reason}: ${r.error ?? ""}`)
    }
    await agent.bus.flush()
    const a = analyse(mock.requests, !variant.endsWith("+compact"))
    const views = [...agent.contextViews.entries()]
    const artifacts = agent.artifacts.list()
    const wrong = new Set(scenario.mustNotDedupe ?? [])
    const replies = agent.messages.filter((m) => m.role === "assistant").length
    const costCached =
      (a.cacheRead * PRICE.cacheRead +
        a.cacheWrite * PRICE.cacheWrite +
        mock.requests.length * OUTPUT_TOKENS * PRICE.output) /
      1e6
    const costUncached =
      ((a.cacheRead + a.cacheWrite) * PRICE.input + mock.requests.length * OUTPUT_TOKENS * PRICE.output) / 1e6
    return {
      variant,
      requests: mock.requests.length,
      summaryRequests: a.summaries,
      peakTokens: a.peak,
      overWindow: a.overWindow,
      area: a.area,
      cacheRead: a.cacheRead,
      cacheWrite: a.cacheWrite,
      outputTokens: replies * OUTPUT_TOKENS,
      costCached,
      costUncached,
      outputReads: agent.messages.flatMap((m) =>
        m.role === "assistant"
          ? m.content.filter((b) => b.type === "toolCall" && b.name === "output_read")
          : [],
      ).length,
      artifacts: artifacts.length,
      artifactBytes: artifacts.reduce((n, x) => n + x.bytes, 0),
      duplicates: views.filter(([, v]) => v.kind === "duplicate").length,
      aged: views.filter(([, v]) => v.kind === "aged").length,
      agingRounds,
      pairingErrors: a.pairing,
      unexpectedChanges: a.unexpected,
      wronglyDeduped: views.filter(
        ([m, v]) => v.kind === "duplicate" && m.role === "toolResult" && wrong.has(m.toolCallId),
      ).length,
      ms: Math.round(performance.now() - started),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function firstFile(work: string): string {
  for (const f of ["src/mod1.ts", "docs/doc1.md", "tree/d0/f0.ts"]) {
    if (Bun.file(path.join(work, f)).size > 0) return f
  }
  return "."
}

export interface MeasureOptions {
  scenarios?: ScenarioName[]
  variants?: VariantName[]
  /** Scales turn and file counts (1 = full size). */
  scale?: number
}

export async function measure(opts: MeasureOptions = {}): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = []
  for (const scenario of opts.scenarios ?? SCENARIOS) {
    const variants: VariantResult[] = []
    for (const v of opts.variants ??
      (["before", "after", "before+compact", "after+compact"] as VariantName[])) {
      variants.push(await runVariant(scenario, v, opts.scale ?? 1))
    }
    out.push({ scenario, variants })
  }
  return out
}

// ---------- report ----------

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(4))

export function report(results: ScenarioResult[]): string {
  const rows: [string, (v: VariantResult) => number][] = [
    ["requests (incl. summaries)", (v) => v.requests],
    ["peak request tokens", (v) => v.peakTokens],
    [`requests over ${WINDOW / 1000}k window`, (v) => v.overWindow],
    ["context area (sum of request tokens)", (v) => v.area],
    ["cache read tokens (est.)", (v) => v.cacheRead],
    ["cache write tokens (est.)", (v) => v.cacheWrite],
    ["cost with caching, USD (illustrative)", (v) => v.costCached],
    ["cost without caching, USD (illustrative)", (v) => v.costUncached],
    ["output_read calls", (v) => v.outputReads],
    ["artifacts saved", (v) => v.artifacts],
    ["artifact bytes", (v) => v.artifactBytes],
    ["reads sent as unchanged notes", (v) => v.duplicates],
    ["results aged to stubs", (v) => v.aged],
    ["aging rounds", (v) => v.agingRounds],
    ["pairing errors (must be 0)", (v) => v.pairingErrors],
    ["unexpected prefix changes (must be 0)", (v) => v.unexpectedChanges],
    ["changed-file reads deduped (must be 0)", (v) => v.wronglyDeduped],
    ["runtime ms", (v) => v.ms],
  ]
  const lines: string[] = []
  for (const r of results) {
    const names = r.variants.map((v) => v.variant)
    const width = 42
    lines.push(`\n== ${r.scenario} ==`)
    lines.push(`${"metric".padEnd(width)}${names.map((n) => n.padStart(16)).join("")}`)
    for (const [label, get] of rows) {
      lines.push(`${label.padEnd(width)}${r.variants.map((v) => fmt(get(v)).padStart(16)).join("")}`)
    }
    const b = r.variants.find((v) => v.variant === "before")
    const a = r.variants.find((v) => v.variant === "after")
    if (a && b) {
      const pct = (x: number, y: number) => (y ? `${Math.round((100 * (x - y)) / y)}%` : "n/a")
      lines.push(
        `after vs before: area ${pct(a.area, b.area)}, peak ${pct(a.peakTokens, b.peakTokens)}, cost with caching ${pct(a.costCached, b.costCached)}`,
      )
    }
  }
  lines.push(
    "\nTokens are estimated (4 ASCII characters or 1 other character a token). Prices are illustrative:",
    `input $${PRICE.input}/M, cache read $${PRICE.cacheRead}/M, cache write $${PRICE.cacheWrite}/M, output $${PRICE.output}/M.`,
    "Cache figures assume a request reuses the longest identical message prefix of the one before it.",
    "The mock model does not enforce the window: 'before' requests over it would fail for real.",
  )
  return lines.join("\n")
}

if (import.meta.main) {
  const json = process.argv.includes("--json")
  const quick = process.argv.includes("--quick")
  const started = performance.now()
  const results = await measure({ scale: quick ? 0.25 : 1 })
  if (json) console.log(JSON.stringify(results, null, 2))
  else {
    console.log(report(results))
    console.log(`\nTotal runtime: ${Math.round(performance.now() - started)} ms`)
  }
}
