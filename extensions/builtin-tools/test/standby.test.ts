import { expect, test } from "bun:test"
import "../../../packages/core/src/index.ts"
import {
  type ReleaseOptions,
  type RunResult,
  type Standby,
  StandbyGoneError,
} from "../../../packages/proc/src/index.ts"
import type { ShellCommand } from "../src/shell.ts"
import { StandbyPool } from "../src/standby.ts"

const result = (output: string): RunResult => ({
  output,
  truncated: false,
  exitCode: 0,
  signalCode: null,
  timedOut: false,
  aborted: false,
  settled: true,
  contained: true,
})

/** A pool over fake processes that records what was prepared, released and run cold. */
function fakePool(opts: { gone?: boolean } = {}) {
  const log: string[] = []
  const standbys: (Standby & { disposed: boolean })[] = []
  let n = 0
  const pool = new StandbyPool({
    prepare: (argv, spawn) => {
      const id = ++n
      log.push(`prepare ${id} ${argv[0]} ${spawn.cwd}`)
      let alive = true
      const s = {
        disposed: false,
        get alive() {
          return alive
        },
        run: async (release: ReleaseOptions) => {
          alive = false
          log.push(`release ${id} ${release.gateLine} ${release.timeoutMs}`)
          if (opts.gone) throw new StandbyGoneError("gone")
          return result(`standby ${id}`)
        },
        dispose() {
          alive = false
          s.disposed = true
          log.push(`dispose ${id}`)
        },
      }
      standbys.push(s)
      return s
    },
    run: async (argv, run) => {
      log.push(`cold ${argv[0]} ${run.cwd} ${run.gateLine}`)
      return result("cold")
    },
  })
  return { pool, log, standbys }
}

const command = (
  gateLine: string,
  env: Record<string, string> = { A: "1" },
  cwd = "C:\\home",
): ShellCommand => ({
  argv: ["pwsh"],
  env,
  cwd,
  gated: true,
  gateLine,
})
const opts = () => ({ timeoutMs: 5000, signal: new AbortController().signal })

test("a matching standby runs the command and a replacement is started", async () => {
  const { pool, log } = fakePool()
  pool.fill(command(""))
  const r = await pool.run(command("Y21k"), opts())
  expect(r.output).toBe("standby 1")
  expect(log).toEqual(["prepare 1 pwsh C:\\home", "release 1 Y21k 5000", "prepare 2 pwsh C:\\home"])
})

test("with no standby the command runs cold and the pool is filled", async () => {
  const { pool, log } = fakePool()
  expect((await pool.run(command("a"), opts())).output).toBe("cold")
  expect((await pool.run(command("b"), opts())).output).toBe("standby 1")
  expect(log).toEqual([
    "cold pwsh C:\\home a",
    "prepare 1 pwsh C:\\home",
    "release 1 b 5000",
    "prepare 2 pwsh C:\\home",
  ])
})

test("a standby for another start directory or environment is replaced, not used", async () => {
  const { pool, log } = fakePool()
  pool.fill(command(""))
  expect((await pool.run(command("a", { A: "1" }, "D:\\other"), opts())).output).toBe("cold")
  expect((await pool.run(command("b", { A: "2" }, "D:\\other"), opts())).output).toBe("cold")
  expect(log).toEqual([
    "prepare 1 pwsh C:\\home",
    "cold pwsh D:\\other a",
    "dispose 1",
    "prepare 2 pwsh D:\\other",
    "cold pwsh D:\\other b",
    "dispose 2",
    "prepare 3 pwsh D:\\other",
  ])
})

test("the environment's key order does not matter", async () => {
  const { pool } = fakePool()
  pool.fill(command("", { A: "1", B: "2" }))
  expect((await pool.run(command("x", { B: "2", A: "1" }), opts())).output).toBe("standby 1")
})

test("a dead standby is skipped, and a gone one falls back to a cold run", async () => {
  const dead = fakePool()
  dead.pool.fill(command(""))
  dead.standbys[0]?.dispose()
  expect((await dead.pool.run(command("a"), opts())).output).toBe("cold")

  const gone = fakePool({ gone: true })
  gone.pool.fill(command(""))
  expect((await gone.pool.run(command("b"), opts())).output).toBe("cold")
  expect(gone.log).toEqual([
    "prepare 1 pwsh C:\\home",
    "release 1 b 5000",
    "prepare 2 pwsh C:\\home",
    "cold pwsh C:\\home b",
  ])
})

test("parallel calls each take the replacement the call before started", async () => {
  const { pool, log } = fakePool()
  pool.fill(command(""))
  const runs = await Promise.all([
    pool.run(command("a"), opts()),
    pool.run(command("b"), opts()),
    pool.run(command("c"), opts()),
  ])
  // Each call takes the standby the previous one started; none waits for another.
  expect(runs.map((r) => r.output)).toEqual(["standby 1", "standby 2", "standby 3"])
  expect(log.filter((l) => l.startsWith("prepare"))).toHaveLength(4)
})

test("commands that are not gated never use the pool", async () => {
  const { pool, log } = fakePool()
  await pool.run({ argv: ["bash"], env: {}, cwd: "C:\\work", gated: false }, opts())
  await pool.run({ argv: ["bash"], env: {}, cwd: "C:\\work", gated: true, viaCmd: true }, opts())
  expect(log).toEqual(["cold bash C:\\work undefined", "cold bash C:\\work undefined"])
})

test("dispose kills the waiting standby", () => {
  const { pool, standbys } = fakePool()
  pool.fill(command(""))
  pool.dispose()
  expect(standbys[0]?.disposed).toBe(true)
})
