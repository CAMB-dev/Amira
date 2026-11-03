import { expect, test } from "bun:test"
import type { FrontendConnectionIssue } from "@amira/core"
import type { RemoteAgentStatus, RemoteAttachIntent } from "../../src/remote/agent-port.ts"
import { attachRetries, BUSY_RETRY_MS } from "../../src/remote/attach-retry.ts"
import { bindingApprover, takeFailureText } from "../../src/remote/attach-roles.ts"
import { RemoteError, RemoteReplyError } from "../../src/remote/errors.ts"
import { classifyReconnectFailure } from "../../src/remote/reconnect-failure.ts"

/** A port whose attempts follow `plan`; a missing step attaches. Nothing touches the network. */
function retryFixture(options: { negotiate?: () => Promise<unknown> } = {}) {
  const listeners = new Set<(status: RemoteAgentStatus) => void>()
  const plan: (() => Promise<void>)[] = []
  const intents: (RemoteAttachIntent | undefined)[] = []
  const issues: (FrontendConnectionIssue | undefined)[] = []
  const timers: { run(): void; ms: number; cleared: boolean }[] = []
  let lost = 0
  // Like the real port, an intent other than take sticks for later attempts.
  let sticky: RemoteAttachIntent | undefined
  const port = {
    status: "connected" as RemoteAgentStatus,
    disconnectionReason: undefined as unknown,
    readOnly: false,
    async reconnect(intent?: RemoteAttachIntent) {
      intents.push(intent)
      if (intent && intent !== "take") sticky = intent
      port.disconnectionReason = undefined
      const step = plan.shift()
      try {
        if (step) await step()
        port.status = "connected"
        port.readOnly = sticky === "viewer"
      } catch (error) {
        port.status = "disconnected"
        port.disconnectionReason = error
        throw error
      }
    },
    subscribeStatus(listener: (status: RemoteAgentStatus) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const retries = attachRetries({
    port,
    negotiate: options.negotiate,
    setConnectionIssue: (issue) => issues.push(issue),
    lost(reason) {
      const taken = (reason as { code?: string } | undefined)?.code === "controller_taken"
      if (taken) lost++
      return taken
    },
    timers: {
      set(run, ms) {
        const timer = { run, ms, cleared: false }
        timers.push(timer)
        return timer
      },
      clear(handle) {
        ;(handle as { cleared: boolean }).cleared = true
      },
    },
  })
  return {
    port,
    plan,
    intents,
    issues,
    timers,
    retries,
    get lost() {
      return lost
    },
    /** The connection closes, as a lost network or a daemon reject would. */
    disconnect(reason: unknown) {
      port.status = "disconnected"
      port.disconnectionReason = reason
      for (const listener of listeners) listener("disconnected")
    },
    /** Runs the one live timer. */
    fire() {
      const live = timers.filter((timer) => !timer.cleared)
      expect(live).toHaveLength(1)
      live[0]!.cleared = true
      live[0]!.run()
    },
    live: () => timers.filter((timer) => !timer.cleared),
  }
}

const settle = () => Bun.sleep(0)
const busy = () => new RemoteReplyError("workspace_busy", "Too many viewers are loading; retry shortly")

test("workspace_busy retries with a growing, bounded delay and a plain message, then waits for /reconnect", async () => {
  const f = retryFixture()
  f.disconnect(busy())
  expect(f.intents).toEqual([])
  expect(f.issues.at(-1)).toEqual({
    code: "workspace_busy",
    message: "The remote workspace is busy: other viewers are still loading it.",
    recovery: "Retrying shortly.",
    retryable: true,
  })
  const delays = [f.live()[0]!.ms]
  for (let attempt = 1; attempt < BUSY_RETRY_MS.length; attempt++) {
    f.plan.push(async () => {
      throw busy()
    })
    f.fire()
    await settle()
    delays.push(f.live()[0]!.ms)
  }
  expect(delays).toEqual([...BUSY_RETRY_MS])
  expect(f.issues.every((issue) => !issue?.recovery.includes("Fix the remote setup"))).toBe(true)
  // The bound: one more busy answer stops the automatic retries.
  f.plan.push(async () => {
    throw busy()
  })
  f.fire()
  await settle()
  expect(f.live()).toEqual([])
  expect(f.issues.at(-1)).toMatchObject({ code: "workspace_busy", retryable: false })
  expect(f.issues.at(-1)!.recovery).toContain("/reconnect")
  expect(f.intents).toHaveLength(BUSY_RETRY_MS.length)

  expect(f.retries.manual()).toBe("started")
  await settle()
  expect(f.port.status).toBe("connected")
  expect(f.issues.at(-1)).toBeUndefined()
  // A success resets the backoff.
  f.disconnect(busy())
  expect(f.live()[0]!.ms).toBe(BUSY_RETRY_MS[0]!)
  f.retries.stop()
})

test("a busy answer to a viewer reconnect after a takeover retries instead of stopping", async () => {
  const f = retryFixture()
  f.plan.push(async () => {
    throw busy()
  })
  f.disconnect(new RemoteReplyError("controller_taken", "Another client took control of this workspace"))
  await settle()
  expect(f.lost).toBe(1)
  expect(f.intents).toEqual(["viewer"])
  expect(f.issues.at(-1)).toMatchObject({ code: "workspace_busy", retryable: true })
  f.fire()
  await settle()
  expect(f.intents).toEqual(["viewer", undefined])
  expect(f.port).toMatchObject({ status: "connected", readOnly: true })
  f.retries.stop()
})

test("a takeover during model negotiation still registers and watches again", async () => {
  const negotiation = Promise.withResolvers<void>()
  let negotiations = 0
  const f = retryFixture({
    negotiate: () => {
      negotiations++
      return negotiations === 1 ? negotiation.promise : Promise.resolve()
    },
  })
  f.disconnect(new RemoteError("disconnected", "Remote attachment closed"))
  await settle()
  expect(f.retries.busy).toBe(true)
  // controller_taken arrives while the reconnect is still binding models.
  f.disconnect(new RemoteReplyError("controller_taken", "Another client took control of this workspace"))
  expect(f.lost).toBe(1)
  negotiation.reject(new RemoteError("disconnected", "Remote attachment unavailable"))
  await settle()
  await settle()
  expect(f.lost).toBe(1)
  expect(f.intents).toEqual([undefined, "viewer"])
  expect(f.port).toMatchObject({ status: "connected", readOnly: true })
  expect(f.issues.some((issue) => issue && !issue.retryable)).toBe(false)
  f.retries.stop()
})

test("a takeover seen only as the failed attempt's reason registers once", async () => {
  const taken = new RemoteReplyError("controller_taken", "Another client took control of this workspace")
  const f = retryFixture({
    negotiate: async () => {
      // The connection already closed for the takeover, before any status listener ran.
      f.port.status = "disconnected"
      f.port.disconnectionReason = taken
      throw new RemoteError("disconnected", "Remote attachment unavailable")
    },
  })
  await f.retries.retry()
  await settle()
  expect(f.lost).toBe(1)
  expect(f.intents).toEqual([undefined, "viewer"])
  expect(f.port.readOnly).toBe(true)
  expect(f.issues.some((issue) => issue && !issue.retryable)).toBe(false)
  f.retries.stop()
})

test("busy failures are classified as retryable, not as a setup failure", () => {
  expect(classifyReconnectFailure(busy())).toMatchObject({ code: "workspace_busy", retryable: true })
  expect(classifyReconnectFailure(new RemoteReplyError("invalid_workspace", "gone"))).toMatchObject({
    retryable: false,
  })
  expect(takeFailureText(busy())).toContain("Try again shortly")
})

test("a new provider binding is asked before mount, in the UI only during /take, and never otherwise", async () => {
  const binding = {
    provider: "openai",
    dialect: "openai",
    localProvider: "openai",
    endpointOrigin: "https://api.openai.com",
    remoteOrigin: "https://api.openai.com",
  }
  let mounted = false
  let promoting = false
  const asked: string[] = []
  let answer = true
  const approve = bindingApprover({
    mounted: () => mounted,
    promoting: () => promoting,
    beforeMount: async () => {
      asked.push("terminal")
      return true
    },
    confirm: async (title, message) => {
      asked.push(`dialog: ${title} ${message}`)
      return answer
    },
  })
  expect(await approve(binding)).toBe(true)
  mounted = true
  expect(await approve(binding)).toBe(false)
  promoting = true
  expect(await approve(binding)).toBe(true)
  answer = false
  expect(await approve(binding)).toBe(false)
  expect(asked[0]).toBe("terminal")
  expect(asked).toHaveLength(3)
  expect(asked[1]).toContain("Allow remote provider openai to use local provider openai?")
  expect(asked[1]).toContain("billed to that local account")
})
