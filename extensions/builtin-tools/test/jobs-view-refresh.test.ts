import { expect, test } from "bun:test"
import { JobRegistry } from "../../../packages/proc/src/index.ts"
import { jobView } from "../src/jobs-ui.ts"

test("job elapsed headers explicitly refresh only while the job is live", () => {
  let finish = () => {}
  const registry = new JobRegistry({
    start(_spec, emit) {
      emit({ type: "spawned", pid: 123, contained: true })
      finish = () => emit({ type: "exit", code: 0, signal: null })
      return { stop: finish }
    },
  })
  const job = registry.start({ command: "fixture", argv: [], cwd: process.cwd() })
  const view = jobView(registry)
  const requests: number[] = []
  const options = { width: 80, now: job.startedAt + 1000, requestRefresh: (ms: number) => requests.push(ms) }
  view.header!({ id: job.id }, options)
  expect(requests).toEqual([1000])
  requests.length = 0
  finish()
  view.header!({ id: job.id }, options)
  view.header!({ id: "gone" }, options)
  expect(requests).toEqual([])
})
