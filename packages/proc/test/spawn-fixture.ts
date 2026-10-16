import { stopSpawn, waitForSpawnCondition, waitForSpawnWork } from "../../../scripts/spawn-test.ts"
import {
  prepareCommand as prepare,
  prepareCommandInline as prepareInline,
  runCommand as run,
  type Standby,
} from "../src/index.ts"

const children = new Set<Bun.Subprocess>()
const prepared = new Set<Standby>()
const pending = new Set<Promise<unknown>>()
let abort = new AbortController()

function track<T>(work: Promise<T>): Promise<T> {
  pending.add(work)
  void work.then(
    () => pending.delete(work),
    () => pending.delete(work),
  )
  return work
}

/** Keep ownership when a test times out before its production helper settles. */
export const runCommand: typeof run = (argv, opts) =>
  track(run(argv, { ...opts, signal: AbortSignal.any([opts.signal, abort.signal]) }))

function own(standby: Standby): Standby {
  prepared.add(standby)
  return {
    get alive() {
      return standby.alive
    },
    run: (opts) => track(standby.run({ ...opts, signal: AbortSignal.any([opts.signal, abort.signal]) })),
    dispose() {
      const work = standby.dispose()
      void work.then(
        () => prepared.delete(standby),
        () => {},
      )
      return work
    },
  }
}

export const prepareCommand: typeof prepare = (argv, opts) => own(prepare(argv, opts))
export const prepareCommandInline: typeof prepareInline = (argv, opts, onIdleExit) =>
  own(prepareInline(argv, opts, onIdleExit))

export function ownSpawn<T extends Bun.Subprocess>(child: T): T {
  children.add(child)
  return child
}

export async function cleanupProcWork(cleanup: (() => unknown)[]) {
  const results = await Promise.allSettled(cleanup.map((close) => Promise.resolve().then(close)))
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
  if (errors.length) throw new AggregateError(errors, "proc fixture cleanup")
}

export async function stopCommands() {
  abort.abort()
  try {
    await cleanupProcWork([
      ...[...prepared].map((standby) => async () => {
        await waitForSpawnWork("idle standby native exit", standby.dispose())
        prepared.delete(standby)
      }),
      ...[...children].map((child) => async () => {
        await stopSpawn(child, "proc fixture child cleanup")
        children.delete(child)
      }),
      () => waitForSpawnCondition("proc command cleanup", () => pending.size === 0),
    ])
  } finally {
    // A failed reap must not abort every command in the next test. Failed resources
    // remain owned so the next cleanup can retry them.
    abort = new AbortController()
  }
}
