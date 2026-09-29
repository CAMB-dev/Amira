// PROTOTYPE — not production. Fake data + a tiny simulation for the orchestration dashboard
// prototype (see ../orchestration-dashboard.prototype.ts). In-memory only, deterministic.

export type Status = "queued" | "running" | "paused" | "approval" | "done" | "failed"
export type StepState = "todo" | "doing" | "done"
export type PhaseStatus = "waiting" | "running" | "done" | "failed"

export interface FileChange {
  path: string
  add: number
  del: number
  diff: string[]
}

export interface Step {
  text: string
  state: StepState
}

export type Action =
  | { k: "step"; d: number }
  | { k: "tool"; name: string; arg: string; d: number }
  | { k: "log"; text: string; d: number }
  | { k: "think"; text: string; d: number }
  | { k: "edit"; file: FileChange; d: number }
  | { k: "approve"; what: string; d: number }
  | { k: "say"; to: string; text: string; d: number }
  | { k: "post"; key: string; value: string; d: number }
  | { k: "spawn"; ids: string[]; d: number }
  | { k: "join"; d: number }
  | { k: "fail"; why: string; d: number }

export type LogKind = "tool" | "out" | "think" | "edit" | "user" | "sys" | "err" | "say"

export interface LogLine {
  at: number
  kind: LogKind
  text: string
}

export interface Agent {
  id: string
  name: string
  role: string
  task: string
  tag: string
  summary: string
  phase: string
  parent?: string
  status: Status
  steps: Step[]
  tool?: string
  logs: LogLine[]
  files: FileChange[]
  tokens: number
  cost: number
  startedAt?: number
  endedAt?: number
  notes: string[]
  script: Action[]
  pc: number
  wait: number
  approval?: string
  partial?: { text: string; shown: number }
  pausedFrom?: Status
}

export interface Phase {
  id: string
  name: string
  status: PhaseStatus
  ref: string
  /** Most agents of this phase running at once. */
  max?: number
  startedAt?: number
  endedAt?: number
}

export interface Msg {
  at: number
  from: string
  to: string
  text: string
}

export interface BoardEntry {
  at: number
  by: string
  key: string
  value: string
}

export type Tone = "info" | "ok" | "warn" | "err" | "user"

export interface Evt {
  at: number
  who: string
  text: string
  tone: Tone
}

export interface Run {
  kind: "workflow" | "swarm"
  title: string
  request: string
  workspace: string
  phases: Phase[]
  agents: Agent[]
  events: Evt[]
  board: BoardEntry[]
  msgs: Msg[]
  clock: number
  later: { at: number; fn: () => void }[]
  rng: () => number
}

// ---------------------------------------------------------------------------------------------
// Script DSL

type Part = Action | Action[]
const seq = (...parts: Part[]): Action[] => parts.flat()
const step = (d = 0.8): Action => ({ k: "step", d })
const think = (text: string, d = 1): Action => ({ k: "think", text, d })
const tool = (name: string, arg: string, out: string[] = [], d = 1.2): Action[] => [
  { k: "tool", name, arg, d: 0.8 },
  ...out.map((text): Action => ({ k: "log", text, d: 0.5 })),
  { k: "log", text: "", d },
]
const edit = (file: FileChange, d = 1.5): Action => ({ k: "edit", file, d })
const approve = (what: string): Action => ({ k: "approve", what, d: 0.5 })
const say = (to: string, text: string, d = 1.5): Action => ({ k: "say", to, text, d })
const post = (key: string, value: string, d = 1): Action => ({ k: "post", key, value, d })
const spawn = (...ids: string[]): Action => ({ k: "spawn", ids, d: 0.5 })
const join = (): Action => ({ k: "join", d: 0.5 })
const fail = (why: string): Action => ({ k: "fail", why, d: 0 })
const wait = (d: number): Action => ({ k: "log", text: "", d })

function file(path: string, diff: string): FileChange {
  const lines = diff.replace(/^\n/, "").trimEnd().split("\n")
  let add = 0
  let del = 0
  for (const l of lines) {
    if (l.startsWith("+")) add++
    else if (l.startsWith("-")) del++
  }
  return { path, add, del, diff: lines }
}

function agent(
  a: Pick<Agent, "id" | "name" | "role" | "task" | "tag" | "summary" | "phase"> & {
    parent?: string
    steps?: string[]
    notes?: string[]
    script: Action[]
  },
): Agent {
  return {
    ...a,
    status: "queued",
    steps: (a.steps ?? []).map((text) => ({ text, state: "todo" as StepState })),
    logs: [],
    files: [],
    tokens: 0,
    cost: 0,
    notes: a.notes ?? [],
    pc: 0,
    wait: 0,
  }
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------------------------
// Diffs

const REFRESH_TOKEN = file(
  "src/auth/refresh-token.ts",
  `
@@ -1,12 +1,34 @@
 import { db } from "../db"
-import { signToken } from "./jwt"
+import { signToken, verifyToken } from "./jwt"
+import { uuidv7 } from "../util/uuid"
+import { TokenReuseError } from "./errors"

 export interface RefreshToken {
   userId: string
+  jti: string
+  family: string
   expiresAt: Date
 }

+/** Issues a new refresh token and revokes the one it replaces. */
+export async function rotateRefreshToken(old: string): Promise<string> {
+  const claims = await verifyToken(old)
+  const row = await db.refreshTokens.findByJti(claims.jti)
+  if (!row || row.revokedAt) {
+    // Reuse of a revoked token: revoke the whole family.
+    await db.refreshTokens.revokeFamily(claims.family)
+    throw new TokenReuseError(claims.sub)
+  }
+  await db.refreshTokens.revoke(claims.jti)
+  const jti = uuidv7()
+  await db.refreshTokens.insert({ jti, userId: claims.sub, family: claims.family })
+  return signToken({ sub: claims.sub, jti, family: claims.family })
+}
+
 export function issueRefreshToken(userId: string): string {
-  return signToken({ sub: userId })
+  const jti = uuidv7()
+  void db.refreshTokens.insert({ jti, userId, family: jti })
+  return signToken({ sub: userId, jti, family: jti })
 }`,
)

const LOGOUT = file(
  "src/auth/logout.ts",
  `
@@ -4,9 +4,13 @@ import { clearSession } from "./session"

 export async function logout(req: Request): Promise<Response> {
   const session = await clearSession(req)
-  // TODO: refresh tokens stay valid until they expire
+  const refresh = readRefreshCookie(req)
+  if (refresh) {
+    const { jti } = decodeToken(refresh)
+    await db.refreshTokens.revoke(jti)
+  }
   return new Response(null, {
     status: 204,
-    headers: { "set-cookie": expireCookie("sid") },
+    headers: [["set-cookie", expireCookie("sid")], ["set-cookie", expireCookie("rt")]],
   })
 }`,
)

const RT_TEST = file(
  "test/auth/refresh-token.test.ts",
  `
@@ -0,0 +1,22 @@
+import { expect, test } from "bun:test"
+import { issueRefreshToken, rotateRefreshToken } from "../../src/auth/refresh-token"
+
+test("rotates on refresh", async () => {
+  const first = issueRefreshToken("u1")
+  const second = await rotateRefreshToken(first)
+  expect(second).not.toBe(first)
+})
+
+test("revokes the family when a revoked token is reused", async () => {
+  const first = issueRefreshToken("u1")
+  await rotateRefreshToken(first)
+  await expect(rotateRefreshToken(first)).rejects.toThrow("TokenReuseError")
+})
+
+test("logout revokes by jti", async () => {
+  const token = issueRefreshToken("u1")
+  await logout(requestWithCookie("rt", token))
+  await expect(rotateRefreshToken(token)).rejects.toThrow()
+})`,
)

const MIGRATION = file(
  "db/migrations/20240512_add_jti.sql",
  `
@@ -0,0 +1,14 @@
+-- Refresh token rotation: every token gets an id (jti) and a family.
+ALTER TABLE refresh_tokens
+  ADD COLUMN jti uuid,
+  ADD COLUMN family uuid,
+  ADD COLUMN revoked_at timestamptz;
+
+UPDATE refresh_tokens SET jti = gen_random_uuid(), family = gen_random_uuid()
+  WHERE jti IS NULL;
+
+ALTER TABLE refresh_tokens ALTER COLUMN jti SET NOT NULL;
+
+CREATE UNIQUE INDEX CONCURRENTLY refresh_tokens_jti_idx ON refresh_tokens (jti);
+CREATE INDEX CONCURRENTLY refresh_tokens_family_idx ON refresh_tokens (family)
+  WHERE revoked_at IS NULL;`,
)

const DOCS = file(
  "docs/auth/登录流程.md",
  `
@@ -18,6 +18,18 @@ 用户登录后，服务端签发访问令牌和刷新令牌。

 ## 刷新令牌

-刷新令牌有效期为 30 天，在此期间可以反复使用。
+刷新令牌有效期为 30 天，但每个令牌只能使用一次：
+
+1. 客户端用刷新令牌换取新的访问令牌时，服务端同时签发新的刷新令牌（轮换）。
+2. 旧令牌立即作废，记录在 \`refresh_tokens.revoked_at\`。
+3. 如果有人再次使用已作废的令牌，同一家族（family）的全部令牌都会作废，
+   用户需要重新登录。
+
+## 退出登录
+
+退出登录会作废当前的刷新令牌（按 jti），并清除 \`sid\` 和 \`rt\` 两个 cookie。
+
 ## 时序图

-见 \`login-sequence.svg\`。
+见 \`login-sequence.svg\`（已加入轮换和作废两个分支）。`,
)

const INDEX = file(
  "src/auth/index.ts",
  `
@@ -1,6 +1,7 @@
 export { login } from "./login"
 export { logout } from "./logout"
-export { issueRefreshToken } from "./refresh-token"
+export { issueRefreshToken, rotateRefreshToken } from "./refresh-token"
+export { TokenReuseError } from "./errors"
 export { requireSession } from "./session"`,
)

const FIXTURE = file(
  "test/fixtures/tokens.ts",
  `
@@ -3,7 +3,8 @@ import { signToken } from "../../src/auth/jwt"

 export function fixtureRefreshToken(userId = "u1"): string {
-  return signToken({ sub: userId })
+  const jti = crypto.randomUUID()
+  return signToken({ sub: userId, jti, family: jti })
 }`,
)

const LRU = file(
  "src/catalog/lru-cache.ts",
  `
@@ -0,0 +1,21 @@
+/** In-process cache for catalog pages: 1,000 entries, 30 s TTL. */
+export class LruCache<V> {
+  private map = new Map<string, { value: V; expires: number }>()
+  constructor(private max = 1000, private ttlMs = 30_000) {}
+
+  get(key: string): V | undefined {
+    const hit = this.map.get(key)
+    if (!hit || hit.expires < Date.now()) return undefined
+    this.map.delete(key)
+    this.map.set(key, hit)
+    return hit.value
+  }
+
+  set(key: string, value: V): void {
+    this.map.delete(key)
+    this.map.set(key, { value, expires: Date.now() + this.ttlMs })
+    if (this.map.size > this.max) {
+      this.map.delete(this.map.keys().next().value!)
+    }
+  }
+}`,
)

const REDIS = file(
  "src/catalog/redis-cache.ts",
  `
@@ -0,0 +1,17 @@
+import { redis } from "../infra/redis"
+
+/** Read-through cache in Redis db 3, shared by every node. */
+export async function cached<T>(key: string, load: () => Promise<T>, ttl = 60): Promise<T> {
+  const raw = await redis.get(\`catalog:\${key}\`)
+  if (raw) return JSON.parse(raw) as T
+  const value = await load()
+  await redis.set(\`catalog:\${key}\`, JSON.stringify(value), "EX", ttl)
+  return value
+}
+
+export async function invalidate(sku: string): Promise<void> {
+  const keys = await redis.smembers(\`catalog:by-sku:\${sku}\`)
+  if (keys.length) await redis.del(...keys)
+  await redis.publish("catalog:invalidate", sku)
+}`,
)

const ADR = file(
  "docs/adr/0007-catalog-cache.md",
  `
@@ -0,0 +1,12 @@
+# 7. Catalog cache
+
+Status: accepted
+
+## Decision
+
+Redis read-through cache (60 s TTL) with a 2 s in-process LRU in front.
+Writes publish \`catalog:invalidate\`; every node drops its LRU entry.
+
+## Why
+
+Per-node LRU alone served stale prices for up to 30 s (critic). Redis alone: p95 71 ms.`,
)

// ---------------------------------------------------------------------------------------------
// Data sets

export function workflowRun(seed = 7): Run {
  const phases: Phase[] = [
    { id: "ph:request", name: "User request", status: "done", ref: "req-7f3a", startedAt: 0, endedAt: 0 },
    { id: "ph:plan", name: "Plan", status: "waiting", ref: "plan-9c1b" },
    { id: "ph:code", name: "Code", status: "waiting", ref: "job-3a9d", max: 2 },
    { id: "ph:integrate", name: "Integrate", status: "waiting", ref: "int-a1d2" },
    { id: "ph:check", name: "Check", status: "waiting", ref: "chk-5e7f" },
    { id: "ph:complete", name: "Complete", status: "waiting", ref: "cmp-b8c3" },
  ]
  const agents: Agent[] = [
    agent({
      id: "planner",
      name: "planner",
      role: "Plan Agent",
      task: "Break the request into tasks",
      tag: "plan",
      summary: "Read the auth module and split the change into three worker tasks.",
      phase: "ph:plan",
      steps: ["Read the auth module", "Draft the plan", "Split into worker tasks"],
      script: seq(
        think(
          "The request touches token issuance, storage and logout. Let me look at how refresh tokens work today.",
        ),
        tool("grep", "-rn refreshToken src/", [
          "src/auth/session.ts:14:  const refreshToken = issueRefreshToken(user.id)",
          "src/auth/logout.ts:8:export async function logout(req: Request) {",
          "src/routes/auth.ts:22:  router.post('/refresh', refresh)",
        ]),
        tool("read_file", "src/auth/refresh-token.ts", ["(12 lines)"]),
        step(),
        think(
          "Plan: rotation helper and jti in TS, a migration for jti/family, and the docs. Integrate once all three land.",
        ),
        wait(2),
        step(),
        tool("todo_write", "3 tasks", [
          "[ ] task-auth-middleware  (TypeScript)",
          "[ ] task-token-repo       (PostgreSQL)",
          "[ ] 更新登录流程文档        (Markdown)",
        ]),
        wait(1),
      ),
    }),
    agent({
      id: "worker-1",
      name: "worker-1",
      role: "Code Agent",
      task: "task-auth-middleware",
      tag: "TypeScript",
      summary: "Add rotateRefreshToken() and persist jti. Update logout to revoke.",
      phase: "ph:code",
      steps: [
        "Add rotateRefreshToken() helper",
        "Persist jti to refresh_tokens",
        "Update logout to revoke tokens by jti",
        "Add unit tests",
        "Run lint and typecheck",
      ],
      notes: ["Using uuid v7 for jti. Revocation via jti blacklist + token families."],
      script: seq(
        think("Starting with the helper. Reuse of a revoked token should revoke the whole family."),
        tool("read_file", "src/auth/refresh-token.ts", ["(12 lines)"]),
        tool("read_file", "src/auth/jwt.ts", ["(48 lines)"]),
        wait(3),
        edit(REFRESH_TOKEN, 3),
        step(),
        tool("grep", "-n insert src/db/refresh-tokens.ts", [
          "src/db/refresh-tokens.ts:9:  insert(row: NewRefreshToken) {",
        ]),
        wait(3),
        step(),
        tool("read_file", "src/auth/logout.ts", ["(13 lines)"]),
        think("Logout needs the rt cookie too, otherwise the browser keeps a revoked token around."),
        wait(4),
        edit(LOGOUT, 3),
        step(),
        wait(3),
        edit(RT_TEST, 2),
        step(),
        approve("bash: bun test test/auth"),
        tool("bash", "bun test test/auth", [
          "✓ rotates on refresh [4ms]",
          "✓ revokes the family when a revoked token is reused [6ms]",
          "✓ logout revokes by jti [3ms]",
          "3 pass · 0 fail",
        ]),
        tool("bash", "bun run typecheck", ["no errors"]),
        wait(1),
      ),
    }),
    agent({
      id: "worker-2",
      name: "worker-2",
      role: "Code Agent",
      task: "task-token-repo",
      tag: "PostgreSQL",
      summary: "Add jti column and index for refresh_tokens.",
      phase: "ph:code",
      steps: ["Add jti and family columns", "Backfill existing rows", "Add indexes", "Dry-run the migration"],
      script: seq(
        tool("ls", "db/migrations", ["20240301_init.sql", "20240418_sessions.sql"]),
        tool("read_file", "db/migrations/20240418_sessions.sql", ["(31 lines)"]),
        think(
          "CREATE INDEX CONCURRENTLY can't run inside a transaction; the runner wraps each file, so I'll mark it.",
        ),
        wait(5),
        step(),
        wait(4),
        edit(MIGRATION, 3),
        step(),
        wait(4),
        step(),
        tool("bash", "bun run db:migrate --dry-run", [
          "20240512_add_jti.sql  ok (no transaction)",
          "1 migration would run",
        ]),
        wait(2),
      ),
    }),
    agent({
      id: "worker-3",
      name: "worker-3",
      role: "Code Agent",
      task: "更新登录流程文档",
      tag: "Markdown",
      summary: "在登录流程文档里补充刷新令牌轮换和退出登录的说明。",
      phase: "ph:code",
      steps: ["阅读现有文档", "补充刷新令牌轮换说明", "更新时序图说明"],
      script: seq(
        tool("read_file", "docs/auth/登录流程.md", ["(41 lines)"]),
        step(),
        think("文档里写着刷新令牌可以反复使用，需要改成一次性并说明家族作废。"),
        wait(4),
        edit(DOCS, 3),
        step(),
        wait(3),
      ),
    }),
    agent({
      id: "integrator",
      name: "integrator",
      role: "Integrate Agent",
      task: "Merge worker branches",
      tag: "git",
      summary: "Merge the three worktrees into the run branch and resolve conflicts.",
      phase: "ph:integrate",
      steps: ["Merge worker-1", "Merge worker-2", "Merge worker-3", "Resolve conflicts"],
      script: seq(
        tool("bash", "git merge --no-ff amira/worker-1", [
          "Merge made by the 'ort' strategy.",
          " 3 files changed",
        ]),
        step(),
        tool("bash", "git merge --no-ff amira/worker-2", ["Merge made by the 'ort' strategy."]),
        step(),
        tool("bash", "git merge --no-ff amira/worker-3", [
          "Auto-merging src/auth/index.ts",
          "CONFLICT (content): Merge conflict in src/auth/index.ts",
        ]),
        step(),
        think("Both sides touched the exports; keep both."),
        wait(3),
        edit(INDEX, 2),
        tool("bash", "git commit --no-edit", ["[amira/run-7f3a 1c9e2d4] Merge branch 'amira/worker-3'"]),
      ),
    }),
    agent({
      id: "checker",
      name: "checker",
      role: "Check Agent",
      task: "Typecheck, test, review",
      tag: "check",
      summary: "Run typecheck and tests in parallel, fix what breaks, review the combined diff.",
      phase: "ph:check",
      steps: ["Typecheck and test", "Fix failures", "Review the combined diff"],
      script: seq(
        spawn("typecheck", "tests"),
        join(),
        think("One failing test: the session fixture still signs tokens without a jti."),
        step(),
        tool("read_file", "test/fixtures/tokens.ts", ["(9 lines)"]),
        edit(FIXTURE, 2),
        spawn("tests-2"),
        join(),
        step(),
        tool("review", "git diff main...amira/run-7f3a", [
          "7 files changed, 121 insertions(+), 9 deletions(-)",
          "no issues",
        ]),
        wait(2),
      ),
    }),
    agent({
      id: "typecheck",
      name: "typecheck",
      role: "Check",
      task: "bun run typecheck",
      tag: "tsc",
      summary: "Typecheck the merged tree.",
      phase: "ph:check",
      parent: "checker",
      script: seq(tool("bash", "bun run typecheck", ["no errors"]), wait(4)),
    }),
    agent({
      id: "tests",
      name: "tests",
      role: "Check",
      task: "bun test",
      tag: "bun",
      summary: "Run the whole test suite.",
      phase: "ph:check",
      parent: "checker",
      script: seq(
        tool("bash", "bun test", [
          "✓ rotates on refresh [4ms]",
          "✓ logout revokes by jti [3ms]",
          "✗ session › issues a refresh token with a jti",
          "    expected claims.jti to be defined",
          "41 pass · 1 fail",
        ]),
        wait(2),
        fail("1 failing test"),
      ),
    }),
    agent({
      id: "tests-2",
      name: "tests (retry)",
      role: "Check",
      task: "bun test",
      tag: "bun",
      summary: "Re-run the suite after the fixture fix.",
      phase: "ph:check",
      parent: "checker",
      script: seq(tool("bash", "bun test", ["42 pass · 0 fail"]), wait(3)),
    }),
  ]
  return {
    kind: "workflow",
    title: "refresh-token-rotation",
    request: "Add refresh token rotation and invalidate on logout",
    workspace: "~/work/amira",
    phases,
    agents,
    events: [
      { at: 0, who: "you", text: "Add refresh token rotation and invalidate on logout", tone: "user" },
    ],
    board: [],
    msgs: [],
    clock: 0,
    later: [],
    rng: mulberry32(seed),
  }
}

export function swarmRun(seed = 11): Run {
  const phases: Phase[] = [
    { id: "ph:request", name: "User request", status: "done", ref: "req-c41e", startedAt: 0, endedAt: 0 },
    { id: "ph:brief", name: "Brief", status: "waiting", ref: "brf-02aa" },
    { id: "ph:swarm", name: "Swarm", status: "waiting", ref: "swm-77d0" },
    { id: "ph:consensus", name: "Consensus", status: "waiting", ref: "cns-1b5f" },
    { id: "ph:complete", name: "Complete", status: "waiting", ref: "cmp-e90c" },
  ]
  const agents: Agent[] = [
    agent({
      id: "lead",
      name: "lead",
      role: "Commander",
      task: "Frame the problem, assign angles",
      tag: "lead",
      summary: "Set the goal and constraints on the blackboard, give each member an angle.",
      phase: "ph:brief",
      steps: ["Set goal and constraints", "Assign angles"],
      script: seq(
        think("Goal first, so everyone measures against the same number."),
        post("goal", "p95 < 80 ms for GET /catalog at 500 rps"),
        post("constraint", "no new infra beyond Redis (already deployed)"),
        step(),
        say(
          "all",
          "scout: measure hot keys. coder-a: in-process LRU. coder-b: Redis read-through. critic: poke holes.",
        ),
        wait(1),
      ),
    }),
    agent({
      id: "scout",
      name: "scout",
      role: "Researcher",
      task: "Measure the current traffic shape",
      tag: "bench",
      summary: "Benchmark GET /catalog and find the hot keys.",
      phase: "ph:swarm",
      steps: ["Benchmark current p95", "Find hot keys", "Check Redis latency"],
      script: seq(
        tool("bash", "k6 run bench/catalog.js", [
          "p50=88ms p95=212ms p99=380ms",
          "hot: /catalog?page=1 (41%)",
        ]),
        step(),
        post("finding", "41% of reads hit page 1; long flat tail after page 20"),
        say(
          "all",
          "Page 1 is 41% of traffic, the tail is flat. Any cache that holds ~50 pages wins most of it.",
        ),
        step(),
        spawn("doc-reader"),
        join(),
        say("coder-b", "Redis is 0.6 ms p50 from the app nodes in staging, so a round trip is cheap."),
        step(),
        wait(2),
      ),
    }),
    agent({
      id: "doc-reader",
      name: "doc-reader",
      role: "Helper",
      task: "Read Redis client-side caching docs",
      tag: "web",
      summary: "Summarize Redis client-side caching for the scout.",
      phase: "ph:swarm",
      parent: "scout",
      script: seq(
        tool("web_fetch", "redis.io/docs/manual/client-side-caching", ["(9.2k chars)"]),
        think("Tracking mode needs RESP3 and a dedicated connection; probably overkill for a prototype."),
        wait(2),
      ),
    }),
    agent({
      id: "coder-a",
      name: "coder-a",
      role: "Coder",
      task: "Prototype an in-process LRU",
      tag: "TypeScript",
      summary: "Per-node LRU in front of the catalog query.",
      phase: "ph:swarm",
      steps: ["Write the LRU", "Wire into the route", "Benchmark"],
      script: seq(
        think("Map keeps insertion order, so an LRU is delete-and-reinsert."),
        tool("read_file", "src/routes/catalog.ts", ["(58 lines)"]),
        wait(9),
        edit(LRU, 2),
        step(),
        wait(8),
        step(),
        tool("bash", "k6 run bench/catalog.js", ["p50=9ms p95=64ms p99=140ms"]),
        say("all", "LRU prototype: 1,000 entries, 30 s TTL. p95 64 ms on one node."),
        step(),
        wait(4),
        say("critic", "Invalidation is TTL-only for now. A 2 s TTL still gets p95 to ~70 ms."),
      ),
    }),
    agent({
      id: "coder-b",
      name: "coder-b",
      role: "Coder",
      task: "Prototype a Redis read-through cache",
      tag: "Redis",
      summary: "Shared read-through cache in Redis db 3 with pub/sub invalidation.",
      phase: "ph:swarm",
      steps: ["Write the read-through helper", "Reset the staging cache db", "Benchmark"],
      script: seq(
        think("Read-through keeps the route code simple: cached(key, load)."),
        tool("read_file", "src/infra/redis.ts", ["(24 lines)"]),
        wait(8),
        edit(REDIS, 3),
        step(),
        approve("bash: redis-cli -n 3 FLUSHDB   (staging)"),
        tool("bash", "redis-cli -n 3 FLUSHDB", ["OK"]),
        step(),
        tool("bash", "k6 run bench/catalog.js", ["p50=14ms p95=71ms p99=118ms"]),
        say("all", "Redis read-through: p95 71 ms, same on every node, invalidation via pub/sub."),
        step(),
        wait(2),
      ),
    }),
    agent({
      id: "critic",
      name: "critic",
      role: "Reviewer",
      task: "Find the failure modes",
      tag: "review",
      summary: "Challenge each proposal: staleness, stampedes, cost.",
      phase: "ph:swarm",
      steps: ["Review the LRU", "Review Redis", "Recommend"],
      script: seq(
        wait(14),
        think(
          "Four app nodes, each with its own LRU: a price change is visible on some nodes and not others.",
        ),
        say("coder-a", "Per-node LRU means 4 nodes can serve 4 different prices for 30 s. Acceptable?"),
        post("risk", "stale prices across nodes with a per-node LRU"),
        step(),
        wait(22),
        post("risk", "cache stampede on page 1 when the Redis key expires"),
        step(),
        wait(14),
        say("all", "I'd take Redis + a 2 s LRU in front, and jitter the TTL to avoid a stampede."),
        step(),
      ),
    }),
    agent({
      id: "lead-2",
      name: "lead",
      role: "Commander",
      task: "Converge and record the decision",
      tag: "lead",
      summary: "Pick a strategy from the blackboard and write it up as an ADR.",
      phase: "ph:consensus",
      steps: ["Weigh the proposals", "Write ADR 0007"],
      script: seq(
        think("Both numbers meet the goal; the critic's staleness point decides it."),
        post("decision", "Redis read-through + 2 s in-process LRU; invalidate via pub/sub"),
        step(),
        edit(ADR, 2),
        say("all", "Decision recorded in ADR 0007. Thanks all."),
        step(),
      ),
    }),
  ]
  return {
    kind: "swarm",
    title: "catalog-cache",
    request: "Pick a caching strategy for the catalog API and prototype it",
    workspace: "~/work/shop-api",
    phases,
    agents,
    events: [
      {
        at: 0,
        who: "you",
        text: "Pick a caching strategy for the catalog API and prototype it",
        tone: "user",
      },
    ],
    board: [],
    msgs: [],
    clock: 0,
    later: [],
    rng: mulberry32(seed),
  }
}

// ---------------------------------------------------------------------------------------------
// Simulation

export const ended = (a: Agent) => a.status === "done" || a.status === "failed"
export const live = (a: Agent) => a.status === "running" || a.status === "paused" || a.status === "approval"
export const topLevel = (run: Run) => run.agents.filter((a) => !a.parent)
export const phaseAgents = (run: Run, phaseId: string) =>
  run.agents.filter((a) => a.phase === phaseId && !a.parent)
export const children = (run: Run, id: string) => run.agents.filter((a) => a.parent === id)
export const byId = (run: Run, id: string) => run.agents.find((a) => a.id === id)

function event(run: Run, who: string, text: string, tone: Tone = "info") {
  run.events.push({ at: run.clock, who, text, tone })
}

function log(run: Run, a: Agent, kind: LogKind, text: string) {
  a.logs.push({ at: run.clock, kind, text })
}

function start(run: Run, a: Agent) {
  a.status = "running"
  a.startedAt = run.clock
  a.wait = 0.5
  const first = a.steps.find((s) => s.state === "todo")
  if (first) first.state = "doing"
  event(run, a.name, `started · ${a.task}`)
}

function finish(run: Run, a: Agent, status: "done" | "failed", why?: string) {
  a.status = status
  a.endedAt = run.clock
  a.tool = undefined
  a.partial = undefined
  if (status === "done") for (const s of a.steps) s.state = "done"
  if (why) log(run, a, "err", why)
  event(run, a.name, status === "done" ? "done" : `failed · ${why}`, status === "done" ? "ok" : "err")
}

function exec(run: Run, a: Agent, act: Action) {
  switch (act.k) {
    case "step": {
      const i = a.steps.findIndex((s) => s.state === "doing")
      if (i >= 0) a.steps[i]!.state = "done"
      const next = a.steps.find((s) => s.state === "todo")
      if (next) next.state = "doing"
      break
    }
    case "tool":
      a.tool = `${act.name} ${act.arg}`
      log(run, a, "tool", `${act.name}  ${act.arg}`)
      break
    case "log":
      if (act.text) log(run, a, "out", act.text)
      break
    case "think":
      a.partial = { text: act.text, shown: 0 }
      break
    case "edit": {
      a.tool = `edit ${act.file.path}`
      const i = a.files.findIndex((f) => f.path === act.file.path)
      if (i >= 0) a.files[i] = act.file
      else a.files.push(act.file)
      log(run, a, "edit", `edit  ${act.file.path}  +${act.file.add} -${act.file.del}`)
      event(run, a.name, `edit ${act.file.path} +${act.file.add} -${act.file.del}`)
      break
    }
    case "approve":
      a.status = "approval"
      a.approval = act.what
      a.tool = act.what
      log(run, a, "sys", `needs approval: ${act.what}`)
      event(run, a.name, `needs approval · ${act.what}`, "warn")
      break
    case "say":
      run.msgs.push({ at: run.clock, from: a.name, to: act.to, text: act.text })
      log(run, a, "say", `→ @${act.to}: ${act.text}`)
      event(run, a.name, `→ @${act.to}: ${act.text}`)
      break
    case "post":
      run.board.push({ at: run.clock, by: a.name, key: act.key, value: act.value })
      log(run, a, "sys", `blackboard ${act.key}: ${act.value}`)
      event(run, a.name, `blackboard · ${act.key}: ${act.value}`)
      break
    case "spawn":
      for (const id of act.ids) {
        const c = byId(run, id)
        if (c && c.status === "queued") start(run, c)
      }
      a.tool = `spawn ${act.ids.join(", ")}`
      log(run, a, "tool", `spawn  ${act.ids.join(", ")}`)
      break
    case "join":
      break
    case "fail":
      finish(run, a, "failed", act.why)
      break
  }
}

function advanceAgent(run: Run, a: Agent, dt: number) {
  a.tokens += dt * (30 + run.rng() * 90)
  a.cost = a.tokens * 0.0000014
  if (a.partial) {
    a.partial.shown += dt * 45
    if (a.partial.shown < a.partial.text.length) return
    log(run, a, "think", a.partial.text)
    a.partial = undefined
  }
  a.wait -= dt
  while (a.wait <= 0 && a.status === "running" && !a.partial) {
    const act = a.script[a.pc]
    if (!act) {
      finish(run, a, "done")
      return
    }
    if (act.k === "join") {
      const kids = children(run, a.id)
      if (kids.some((c) => !ended(c))) {
        a.wait = 0.3
        return
      }
    }
    a.pc++
    exec(run, a, act)
    a.wait += act.d
  }
}

function advancePhases(run: Run) {
  for (const ph of run.phases) {
    if (ph.status === "done" || ph.status === "failed") continue
    const agents = phaseAgents(run, ph.id)
    if (ph.status === "waiting") {
      ph.status = "running"
      ph.startedAt = run.clock
      event(run, "run", `${ph.name} started`)
    }
    const max = ph.max ?? Number.POSITIVE_INFINITY
    let running = agents.filter(live).length
    for (const a of agents) {
      if (running >= max) break
      if (a.status === "queued") {
        start(run, a)
        running++
      }
    }
    if (agents.every(ended)) {
      ph.status = agents.some((a) => a.status === "failed") ? "failed" : "done"
      ph.endedAt = run.clock
      event(run, "run", `${ph.name} ${ph.status}`, ph.status === "done" ? "ok" : "err")
      continue
    }
    return
  }
}

/** Moves the run forward by `dt` simulated seconds. */
export function tick(run: Run, dt: number) {
  run.clock += dt
  advancePhases(run)
  for (const a of run.agents) if (a.status === "running") advanceAgent(run, a, dt)
  const due = run.later.filter((l) => l.at <= run.clock)
  run.later = run.later.filter((l) => l.at > run.clock)
  for (const l of due) l.fn()
}

// ---------------------------------------------------------------------------------------------
// What the user can do

export function togglePause(run: Run, a: Agent): string {
  if (a.status === "paused") {
    a.status = a.pausedFrom ?? "running"
    log(run, a, "user", "resumed by you")
    event(run, a.name, "resumed by you", "user")
    return `${a.name} resumed`
  }
  if (a.status === "running" || a.status === "approval") {
    a.pausedFrom = a.status
    a.status = "paused"
    log(run, a, "user", "paused by you")
    event(run, a.name, "paused by you", "user")
    return `${a.name} paused`
  }
  return `${a.name} is ${a.status}; nothing to pause`
}

export function decide(run: Run, a: Agent, yes: boolean): string {
  const what = a.approval ?? ""
  a.approval = undefined
  a.status = "running"
  a.wait = 0.3
  if (!yes) {
    // Skip the tool call and its output lines.
    while (a.script[a.pc] && a.script[a.pc]!.k !== "step") a.pc++
    a.tool = undefined
  }
  log(run, a, "user", `${yes ? "approved" : "denied"} by you: ${what}`)
  event(run, a.name, `${yes ? "approved" : "denied"} · ${what}`, "user")
  return `${yes ? "Approved" : "Denied"}: ${what}`
}

export function requestChanges(run: Run, a: Agent, text: string): string {
  log(run, a, "user", `change request from you: ${text}`)
  event(run, a.name, `change request · ${text}`, "user")
  a.steps.push({ text: `Address review: ${text}`, state: "todo" })
  const f = a.files[0]
  const tweak: Action[] = [
    { k: "think", text: `Reviewing the change request: "${text}".`, d: 1 },
    ...(f
      ? [
          {
            k: "edit",
            file: { ...f, add: f.add + 2, diff: [...f.diff, `+// review: ${text}`, "+"] },
            d: 2,
          } as Action,
        ]
      : []),
    { k: "step", d: 0.5 },
  ]
  a.script.splice(a.pc, 0, ...tweak)
  if (a.status === "done" || a.status === "failed") {
    a.status = "running"
    a.endedAt = undefined
    a.wait = 0.5
  }
  if (!a.steps.some((s) => s.state === "doing") && a.status !== "queued") {
    const next = a.steps.find((s) => s.state === "todo")
    if (next) next.state = "doing"
  }
  return `Change request sent to ${a.name}`
}

/** A message to the commander, or to a member with a leading @name. */
export function message(run: Run, text: string): string {
  const m = /^@(\S+)\s*(.*)$/.exec(text)
  const target = m
    ? (run.agents.find((a) => a.name === m[1] && !ended(a)) ?? run.agents.find((a) => a.name === m[1]))
    : undefined
  const to = m ? m[1]! : "commander"
  const body = m ? m[2]! : text
  run.msgs.push({ at: run.clock, from: "you", to, text: body })
  event(run, "you", `→ @${to}: ${body}`, "user")
  if (target) log(run, target, "user", `message from you: ${body}`)
  const replyFrom = target?.name ?? (run.kind === "swarm" ? "lead" : "commander")
  run.later.push({
    at: run.clock + 2,
    fn: () => {
      const reply = target
        ? "Got it, folding that into my next step."
        : "Noted. I'll pass it to the relevant worker."
      run.msgs.push({ at: run.clock, from: replyFrom, to: "you", text: reply })
      event(run, replyFrom, `→ @you: ${reply}`)
      if (target) log(run, target, "say", `→ @you: ${reply}`)
    },
  })
  return target || !m ? `Sent to @${to}` : `No member named ${to}; sent anyway`
}
