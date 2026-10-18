import { expect, jest, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  type Ai,
  addUsage,
  createAi,
  createMockDialect,
  emptyUsage,
  type Message,
  type ModelRequest,
  userMessage,
} from "@amira/ai"
import type { AnyEvent, CommandContext, SessionControl } from "@amira/api"
import { defineTool, textResult } from "@amira/api"
import { accountingCleanup } from "../src/accounting-requests.ts"
import { Agent } from "../src/agent.ts"
import { CommandHost, CommandRegistry } from "../src/commands.ts"
import { EventBus } from "../src/event-bus.ts"
import { SessionStore } from "../src/session-store.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"
import { UiRequests } from "../src/ui-requests.ts"

const promptOf = (request: ModelRequest) => {
  const content = request.messages.at(-1)?.content[0]
  return content?.type === "text" ? content.text : ""
}
function random(seed: number) {
  let state = seed >>> 0
  return (n: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state % n
  }
}
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("interleaving did not make progress")), 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const providerBarrier = () => ({
  opened: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
})

for (let seed = 1; seed <= 24; seed++) {
  test(`seed ${seed}: disk and the live owner's memory agree after every resume, display and late-usage step`, async () => {
    const next = random(seed)
    const dir = mkdtempSync(path.join(tmpdir(), "amira-session-interleavings-"))
    const files = ["A", "B"].map((name) => {
      const store = SessionStore.create({ cwd: dir, dir })
      store.append({ type: "display", text: `created ${name}`, level: "info" })
      return store.file
    })
    const messages: Message[][] = [[], []]
    const spent = [0, 0]
    const heads = [new Set(["created A"]), new Set(["created B"])]
    const bus = new EventBus()
    const events: AnyEvent[] = []
    bus.subscribe((event) => void events.push(event))
    let generation = 0
    const make = (origin: number, preOpenedStore?: SessionStore) => {
      const mainBarriers: ReturnType<typeof providerBarrier>[] = []
      const queuedMain: ReturnType<typeof providerBarrier>[] = []
      const opened = Promise.withResolvers<void>()
      const terminal = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const settled = Promise.withResolvers<void>()
      const aborted = Promise.withResolvers<void>()
      let consulted = false
      const mock = createMockDialect(
        Array.from({ length: 100 }, () => (request: ModelRequest) => {
          if (!request.tools.length)
            return { text: "APPROVE", usage: { cost: 3 }, hold: { chunks: 0, until: aborted.promise } }
          if (promptOf(request).startsWith("private"))
            return { toolCalls: [{ name: "read", args: {} }], usage: { cost: 1 } }
          const barrier = queuedMain.shift()
          if (!barrier) throw new Error("main turn missing its provider barrier")
          barrier.opened.resolve()
          return {
            text: "main answer",
            usage: { cost: 0 },
            hold: { chunks: 0, until: barrier.release.promise },
          }
        }),
      )
      const ai: Ai = createAi({
        dialects: [
          {
            ...mock,
            async *stream(request, context) {
              const consultation = request.tools.length === 0
              const onAbort = () => aborted.resolve()
              if (consultation) {
                consulted = true
                context.signal.addEventListener("abort", onAbort, { once: true })
                if (context.signal.aborted) onAbort()
                opened.resolve()
              }
              try {
                for await (const event of mock.stream(request, context)) {
                  if (consultation && event.type === "error" && event.error.code === "aborted") {
                    terminal.resolve()
                    await release.promise
                  }
                  yield event
                }
              } finally {
                context.signal.removeEventListener("abort", onAbort)
                if (consultation) settled.resolve()
              }
            },
          },
        ],
        providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
        retry: { retries: 0 },
      })
      const tree = new AgentTree({ ai, maxConcurrent: 2, sections: () => [] })
      const tools = new ToolRegistry()
      tools.register(
        defineTool({
          name: "read",
          description: "read",
          parameters: {},
          execute: async () => textResult("ok"),
        }),
        "test",
      )
      const session = preOpenedStore ?? SessionStore.open(files[origin]!)
      const agent = new Agent({
        ai,
        tree,
        tools,
        bus,
        session,
        model: ai.model("mock/m"),
        cwd: dir,
        sections: [],
      })
      agent.interceptors.add("tool.call.before", () => ({ action: "ask", reason: "approval required" }))
      return {
        origin,
        agent,
        tree,
        opened,
        terminal,
        release,
        settled,
        consulted: () => consulted,
        mainBarriers,
        holdMain: () => {
          const barrier = providerBarrier()
          mainBarriers.push(barrier)
          queuedMain.push(barrier)
          return barrier
        },
        generation: generation++,
        accountingDone: Promise.resolve(),
      }
    }
    let current = make(0)
    const agents = [current.agent]
    const generations = [current]
    const registry = new CommandRegistry()
    let captured!: CommandContext["print"]
    registry.register(
      {
        name: "capture",
        description: "capture printer",
        run: (_args, ctx) => {
          captured = ctx.print
        },
      },
      "test",
    )
    const host = new CommandHost({
      registry,
      bus,
      agent: current.agent,
      ui: new UiRequests(bus),
      control: {} as SessionControl,
    })
    const printers: { origin: number; print: CommandContext["print"]; store: SessionStore }[] = []
    const pending: (typeof current)[] = []
    const capture = async () => {
      expect((await host.run("/capture", { frontend: "tui" })).ok).toBe(true)
      printers.push({ origin: current.origin, print: captured, store: current.agent.session! })
    }
    const verify = async () => {
      await bus.flush()
      for (let origin = 0; origin < files.length; origin++) {
        const disk = SessionStore.open(files[origin]!)
        expect(disk.restore().messages).toEqual(messages[origin]!)
        const usage = disk.entries
          .filter((entry) => entry.type === "side_usage")
          .reduce((sum, entry) => addUsage(sum, entry.usage), emptyUsage())
        expect(usage.cost ?? 0).toBe(spent[origin]!)
        expect(
          disk.entries
            .filter((entry) => entry.type === "display")
            .map((entry) => entry.text)
            .sort(),
        ).toEqual([...heads[origin]!].sort())
        if (origin === current.origin) {
          expect(disk.restore().messages).toEqual(current.agent.messages)
          expect(JSON.parse(JSON.stringify(current.agent.session!.entries))).toEqual(
            JSON.parse(JSON.stringify(disk.entries)),
          )
          const context = JSON.stringify(current.agent.messages)
          expect(context).not.toContain("private")
          expect(context).not.toContain("display-only answer")
          expect(context).not.toContain("APPROVE")
        }
      }
      expect(
        events.filter((event) => event.type === "extension.error" && event.data.source === "session"),
      ).toEqual([])
      expect(
        events.filter((event) => event.type === "extension.notice" && event.data.level === "warning"),
      ).toEqual([])
    }
    const resume = async (origin: number, preOpenedStore?: SessionStore) => {
      await bounded(current.agent.dispose("switch"))
      await verify()
      current = make(origin, preOpenedStore)
      agents.push(current.agent)
      generations.push(current)
      host.switchTo(current.agent)
      await verify()
      await capture()
      await verify()
    }
    const startLate = async (originAfter: number) => {
      const old = current
      const child = old.tree.spawn(old.agent, {
        prompt: `private ${old.generation}`,
        ephemeral: true,
        maxTurns: 1,
      })
      await bounded(old.opened.promise)
      old.accountingDone = accountingCleanup(child.id)
      spent[old.origin]! += 1
      expect(old.tree.usage.cost).toBe(1)
      await verify()
      let ended = false
      const result = child.result().then((value) => {
        ended = true
        return value
      })
      // Drive the existing child tool-abandonment grace, not the held physical stream.
      // Parent AgentOptions do not configure a spawned child's grace; avoid real sleeps.
      jest.useFakeTimers()
      try {
        child.abort("hold usage through resume")
        for (let round = 0; round < 10 && !ended; round++) {
          jest.advanceTimersByTime(2000)
          for (let tick = 0; tick < 100; tick++) await Promise.resolve()
        }
      } finally {
        jest.useRealTimers()
      }
      await bounded(old.terminal.promise)
      await verify()
      const endedResult = await bounded(result)
      expect(endedResult.status).toBe("aborted")
      expect(endedResult.usage.cost).toBe(1)
      expect(old.tree.usage.cost).toBe(1)
      pending.push(old)
      await verify()
      await resume(originAfter)
    }
    const releaseLate = async (index: number) => {
      const old = pending.splice(index, 1)[0]!
      old.release.resolve()
      await bounded(old.settled.promise)
      // The dialect's finally precedes the outer request-fence finalizer. Wait for both
      // before verifying the complete ledger or handing off the current writer's lease.
      await bounded(old.accountingDone)
      // The observer books terminal usage before the dialect finishes its physical cleanup.
      spent[old.origin]! += 3
      expect(old.tree.usage.cost).toBe(4)
    }
    const activeTurns: Promise<unknown>[] = []
    let displaySequence = 0
    const display = (step: number, printer = printers[next(printers.length)]!) => {
      const text = `display ${seed}/${step}/${displaySequence++}`
      if (next(2)) printer.print(text, "info", { details: "display-only answer", persist: true })
      else printer.store.append({ type: "display", text, details: "display-only answer", level: "info" })
      heads[printer.origin]!.add(text)
    }
    const beginTurn = async (step: number) => {
      const owner = current
      const previous = messages[owner.origin]!
      expect(owner.agent.messages).toEqual(previous)
      const input = `turn ${seed}/${step}`
      const barrier = owner.holdMain()
      let completed = false
      const result = owner.agent.prompt(input)
      activeTurns.push(result)
      void result.then(
        () => {
          completed = true
        },
        () => {
          completed = true
        },
      )
      await bounded(barrier.opened.promise)
      // The user message is already durable, but the assistant and terminal usage are held.
      messages[owner.origin] = [...previous, userMessage(input)]
      expect(completed).toBe(false)
      await verify()
      return { owner, previous, input, barrier, result, completed: () => completed }
    }
    const finishTurn = async (
      held: Awaited<ReturnType<typeof beginTurn>>,
      reason: "done" | "aborted" = "done",
    ) => {
      expect(held.completed()).toBe(false)
      held.barrier.release.resolve()
      expect((await bounded(held.result)).reason).toBe(reason)
      const appended = held.owner.agent.messages.slice(held.previous.length)
      expect(appended).toHaveLength(2)
      expect(appended[0]).toEqual(userMessage(held.input))
      const assistant = appended[1]
      expect(assistant?.role).toBe("assistant")
      if (assistant?.role !== "assistant") throw new Error("main turn did not append an assistant")
      expect(assistant.content).toEqual([{ type: "text", text: reason === "done" ? "main answer" : "" }])
      expect(assistant.stopReason).toBe(reason === "done" ? "end" : "aborted")
      messages[held.owner.origin] = [...held.previous, ...structuredClone(appended)]
      await verify()
    }
    const turn = async (step: number, releasePending = true) => {
      const held = await beginTurn(step)
      // Every random turn has real concurrent metadata work, not just a shuffled serial loop.
      display(step)
      await verify()
      if (releasePending && pending.length && next(2)) {
        await releaseLate(next(pending.length))
        await verify()
      }
      await finishTurn(held)
    }
    const overlappingHandoff = async (step: number) => {
      // This second view reads before the current user's message, display and late receipt.
      // It must not claim until the old Agent has finished disposing and released its lease.
      const preOpenedStore = SessionStore.open(files[current.origin]!)
      const openedEntries = structuredClone(preOpenedStore.entries)
      const held = await beginTurn(step)
      const disposeWhileHeld = next(2) === 0
      let disposed = false
      const disposing = disposeWhileHeld
        ? current.agent.dispose("switch").then(() => {
            disposed = true
          })
        : undefined
      if (disposing) {
        expect(disposed).toBe(false)
        await verify()
      }
      // Choose both writer API and metadata order from the seed. The printer/store is
      // retained from the first generation, not the current owner or the pre-opened view.
      const appendRetained = async () => {
        display(step, printers[0]!)
        await verify()
      }
      const receipt = async () => {
        await releaseLate(0)
        await verify()
      }
      if (next(2)) {
        await appendRetained()
        await receipt()
      } else {
        await receipt()
        await appendRetained()
      }
      expect(held.completed()).toBe(false)
      if (disposing) expect(disposed).toBe(false)
      await finishTurn(held, disposing ? "aborted" : "done")
      if (disposing) {
        await bounded(disposing)
        expect(disposed).toBe(true)
        await verify()
      }
      expect(preOpenedStore.entries).toEqual(openedEntries)
      await resume(held.owner.origin, preOpenedStore)
      expect(current.agent.session).toBe(preOpenedStore)
    }
    try {
      await capture()
      await verify()
      await startLate(0)
      await verify()
      // Retain the late-after-a-completed-turn order as well as late-before-an-answer.
      if (seed % 2) await turn(-3, false)
      // In every seed a main provider, a delayed private receipt, and a pre-opened
      // replacement coexist; some seeds also keep disposal pending through both writes.
      await overlappingHandoff(-1)
      await verify()
      await turn(-2)
      await verify()
      for (let step = 0; step < 20; step++) {
        const action = next(5)
        if (action === 0) await resume(next(2))
        else if (action === 1) display(step)
        else if (action === 2) await startLate(next(2))
        else if (action === 3 && pending.length) await releaseLate(next(pending.length))
        else await turn(step)
        await verify()
      }
      while (pending.length) {
        await releaseLate(next(pending.length))
        await verify()
      }
    } finally {
      jest.useRealTimers()
      for (const old of generations) {
        old.release.resolve()
        for (const barrier of old.mainBarriers) barrier.release.resolve()
      }
      for (const agent of agents) await bounded(agent.dispose())
      await bounded(Promise.allSettled(activeTurns))
      for (const old of generations) if (old.consulted()) await bounded(old.settled.promise)
      await bus.flush()
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
