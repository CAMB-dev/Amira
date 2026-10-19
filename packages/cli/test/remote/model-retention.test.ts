import "../server/offline.ts"
import { expect, test } from "bun:test"
import { ModelRetention } from "../../src/remote/model-retention.ts"
import type { RemoteJson } from "../../src/remote/protocol.ts"
import { deferred } from "./model-proxy-fixture.ts"

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

test("repeated late receipts cannot append unlimited overflow failures", async () => {
  const calls = new ModelRetention({ maxFrames: 1, timeoutMs: 1000 })
  const frames: { seq: number; event: RemoteJson }[] = []
  let aborted = false
  try {
    calls.open({
      callId: "receipts",
      payload: {},
      after: 0,
      resume: false,
      retainReceipts: true,
      send: async (frame) => {
        frames.push(frame)
      },
      failure: (code) => ({ kind: "failure", code }),
      async run(signal, emit) {
        signal.addEventListener("abort", () => {
          aborted = true
        })
        emit({ kind: "compact" }, true)
        for (let i = 0; i < 100; i++) emit({ kind: "receipt", data: i })
      },
    })
    await tick()
    expect(aborted).toBe(true)
    expect(frames).toHaveLength(2)
    expect(frames[1]?.event).toMatchObject({ kind: "failure", code: "proxy_retention_expired" })
  } finally {
    calls.close()
  }
})

test("accepted calls are fingerprinted, bounded, cursor checked and never reissued after ACK", async () => {
  const calls = new ModelRetention({ maxBytes: 100, timeoutMs: 1000 })
  const frames: { seq: number; event: RemoteJson }[] = []
  let executions = 0
  let aborted = false
  const options = {
    callId: "c1",
    payload: { model: "p/m" },
    after: 0,
    resume: false,
    send: async (frame: { seq: number; event: RemoteJson }) => {
      frames.push(frame)
    },
    failure: (code: string) => ({ kind: "failure", code }),
    run: async (signal: AbortSignal, emit: (event: RemoteJson, terminal?: boolean) => void) => {
      executions++
      signal.addEventListener(
        "abort",
        () => {
          aborted = true
        },
        { once: true },
      )
      emit({ text: "one" })
      emit({ text: "x".repeat(200) })
    },
  }
  try {
    calls.open(options)
    await tick()
    expect(executions).toBe(1)
    expect(aborted).toBe(true)
    expect(frames).toHaveLength(2)
    expect(frames[1]?.event).toMatchObject({ kind: "failure", code: "proxy_retention_expired" })
    expect(() => calls.open({ ...options, payload: { model: "changed" } })).toThrow()
    expect(() => calls.open({ ...options, resume: true, after: 3 })).toThrow()
    calls.ack("c1", 2)
    expect(() => calls.open(options)).toThrow()
    expect(() => calls.open({ ...options, callId: "unknown", resume: true })).toThrow()
    expect(executions).toBe(1)
  } finally {
    calls.close()
  }
})

test("detach preserves running work and resumes from the last applied cursor", async () => {
  const calls = new ModelRetention({ timeoutMs: 1000 })
  const release = deferred()
  const initial: number[] = []
  const replay: number[] = []
  let executions = 0
  const options = {
    callId: "c1",
    payload: { model: "p/m" },
    after: 0,
    resume: false,
    send: async (frame: { seq: number }) => {
      initial.push(frame.seq)
    },
    failure: (code: string) => ({ kind: "failure", code }),
    run: async (_signal: AbortSignal, emit: (event: RemoteJson, terminal?: boolean) => void) => {
      executions++
      emit({ text: "one" })
      await release.promise
      emit({ text: "two" }, true)
    },
  }
  try {
    calls.open(options)
    await tick()
    calls.detach()
    release.resolve()
    await tick()
    expect(initial).toEqual([1])
    calls.open({
      ...options,
      resume: true,
      after: 1,
      send: async (frame) => {
        replay.push(frame.seq)
      },
    })
    await tick()
    expect(replay).toEqual([2])
    expect(executions).toBe(1)
    calls.ack("c1", 2)
  } finally {
    release.resolve()
    calls.close()
  }
})
