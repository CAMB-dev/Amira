import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import type { CommandContext, SessionControl, UiApi } from "@amira/api"
import { Agent } from "../src/agent.ts"
import { registerCommandViewContext } from "../src/command-view-context.ts"
import { CommandHost, CommandRegistry, InputRegistry } from "../src/commands.ts"
import { EventBus } from "../src/event-bus.ts"
import { SkillRegistry } from "../src/skills.ts"
import { UiRequests } from "../src/ui-requests.ts"

function setup(control: Partial<SessionControl> = {}) {
  const bus = new EventBus()
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const makeAgent = () => new Agent({ ai, model: ai.model("mock/m"), cwd: "/work", bus })
  const registry = new CommandRegistry()
  const skills = new SkillRegistry()
  const inputs = new InputRegistry()
  const ui = new UiRequests(bus)
  const host = new CommandHost({
    registry,
    skills,
    inputs,
    bus,
    ui,
    control: control as SessionControl,
    agent: makeAgent(),
  })
  return { host, registry, skills, inputs, ui, bus, makeAgent }
}

const kinds = ["command", "skill", "input"] as const

function invocation(
  s: ReturnType<typeof setup>,
  kind: (typeof kinds)[number],
  run: (text: string, ctx: CommandContext) => void | Promise<void>,
) {
  const definition = { name: "late", description: "fixture", run }
  if (kind === "command") {
    s.registry.register(definition, "test")
    return s.host.run.bind(s.host, "/late")
  }
  if (kind === "skill") {
    s.skills.register(definition, "test")
    return s.host.runSkill.bind(s.host, "$late")
  }
  s.inputs.register({ ...definition, claims: () => true }, "test")
  return s.host.runInput.bind(s.host, "late")
}

const methods = [
  "info",
  "trace",
  "messages",
  "contextHas",
  "replies",
  "compactions",
  "sideRequests",
  "subagents",
  "subagentMessages",
  "stopSubagent",
  "messageSubagent",
  "pauseSubagent",
  "resumeSubagent",
  "createGroup",
  "groups",
  "expectNotice",
  "models",
  "setModel",
  "setThinking",
  "setFastMode",
  "newSession",
  "sessions",
  "readSession",
  "resume",
  "rename",
  "deleteSession",
  "fork",
  "rewind",
  "planRewind",
  "pruneFileHistory",
  "compact",
  "send",
  "tools",
  "setToolEnabled",
  "setShell",
  "permissions",
  "providers",
  "preview",
  "reloadExtensions",
] satisfies (keyof SessionControl)[]

for (const kind of kinds) {
  for (const method of methods) {
    test(`a late ${kind} cannot call retained session.${method} on a replacement`, async () => {
      let calls = 0
      let echoes = 0
      const control = {
        [method]: () => {
          calls++
        },
      }
      const s = setup(control)
      const gate = Promise.withResolvers<void>()
      const run = invocation(s, kind, async (_args, ctx) => {
        const retained = ctx.session[method]
        await gate.promise
        if (typeof retained === "function") await Reflect.apply(retained, ctx.session, [])
      })
      const running = run({
        frontend: "tui",
        onSend: () => {
          echoes++
          return undefined
        },
      })
      s.host.switchTo(s.makeAgent())
      gate.resolve()
      expect((await running).ok).toBe(false)
      expect(calls).toBe(0)
      expect(echoes).toBe(0)
    })
  }
}

const effects = ["quit", "openView", "openRewind", "focusConversation", "unfocusConversation"] as const

for (const kind of kinds) {
  for (const invalidation of ["root", "focus"] as const) {
    for (const effect of effects) {
      test(`a late ${kind} cannot invoke ${effect} after ${invalidation} replacement`, async () => {
        const s = setup()
        let focused = true
        let calls = 0
        let result: unknown
        const gate = Promise.withResolvers<void>()
        const run = invocation(s, kind, async (_args, ctx) => {
          const retained = ctx[effect]!
          await gate.promise
          result = Reflect.apply(retained, ctx, [{ kind: "fixture" }])
        })
        const running = run({
          frontend: "tui",
          isFrontendCurrent: () => focused,
          [effect]: () => {
            calls++
            return true
          },
        })
        if (invalidation === "root") s.host.switchTo(s.makeAgent())
        else focused = false
        gate.resolve()
        expect((await running).ok).toBe(true)
        expect(calls).toBe(0)
        expect(result).toBe(effect === "quit" ? undefined : false)
      })
    }
  }
}

for (const kind of ["command", "skill", "input"] as const) {
  test(`${kind} cannot send after another command switches the session`, async () => {
    let sends = 0
    const { host, registry, skills, inputs, makeAgent } = setup({
      send: async () => {
        sends++
      },
    })
    const gate = Promise.withResolvers<void>()
    const run = async (_text: string, ctx: CommandContext) => {
      await gate.promise
      await ctx.session.send("late")
    }
    registry.register({ name: "late", description: "fixture", run }, "test")
    skills.register({ name: "late", description: "fixture", run }, "test")
    inputs.register({ name: "late", claims: () => true, run }, "test")
    registry.register(
      { name: "switch", description: "fixture", run: () => host.switchTo(makeAgent()) },
      "test",
    )
    const running =
      kind === "command"
        ? host.run("/late", { frontend: "rpc" })
        : kind === "skill"
          ? host.runSkill("$late", { frontend: "rpc" })
          : host.runInput("late", { frontend: "rpc" })
    expect((await host.run("/switch", { frontend: "rpc" })).ok).toBe(true)
    gate.resolve()
    expect((await running).ok).toBe(false)
    expect(sends).toBe(0)
  })
}

test("a nested command cannot inherit its caller's pending transition", async () => {
  let sends = 0
  const { host, registry, makeAgent } = setup({
    newSession: async () => {
      await host.run("/other", { frontend: "rpc" })
    },
    send: async () => {
      sends++
    },
  })
  registry.register({ name: "other", description: "fixture", run: () => host.switchTo(makeAgent()) }, "test")
  registry.register(
    {
      name: "own",
      description: "fixture",
      run: async (_args, ctx) => {
        await ctx.session.newSession()
        await ctx.session.send("stale")
      },
    },
    "test",
  )
  expect((await host.run("/own", { frontend: "rpc" })).ok).toBe(false)
  expect(sends).toBe(0)
})

test("a settled transition's escaped callback cannot adopt another replacement", async () => {
  let sends = 0
  let escaped: Promise<void> | undefined
  const gate = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  const { host, registry, makeAgent } = setup({
    newSession: async () => {
      host.switchTo(makeAgent())
      escaped = gate.promise.then(() => host.switchTo(makeAgent()))
    },
    send: async () => {
      sends++
    },
  })
  registry.register(
    {
      name: "own",
      description: "fixture",
      run: async (_args, ctx) => {
        await ctx.session.newSession()
        ready.resolve()
        await gate.promise
        await escaped
        await ctx.session.send("stale")
      },
    },
    "test",
  )
  const running = host.run("/own", { frontend: "rpc" })
  await ready.promise
  gate.resolve()
  expect((await running).ok).toBe(false)
  expect(sends).toBe(0)
})

test("send rechecks authority after the frontend echo callback", async () => {
  let sends = 0
  let cleanups = 0
  const { host, registry, makeAgent } = setup({
    send: async () => {
      sends++
    },
  })
  registry.register(
    {
      name: "send",
      description: "fixture",
      run: (_args, ctx) => ctx.session.send("stale"),
    },
    "test",
  )
  const result = await host.run("/send", {
    frontend: "tui",
    onSend: () => {
      host.switchTo(makeAgent())
      return () => {
        cleanups++
      }
    },
  })
  expect(result.ok).toBe(false)
  expect(sends).toBe(0)
  expect(cleanups).toBe(1)
})

for (const kind of kinds) {
  for (const transition of ["newSession", "resume", "fork", "rewind"] as const) {
    test(`a ${kind} continues on its own asynchronous ${transition} replacement`, async () => {
      let sends = 0
      let views = 0
      const gate = Promise.withResolvers<void>()
      const s = setup({
        [transition]: async () => {
          await gate.promise
          s.host.switchTo(s.makeAgent())
        },
        send: async () => {
          sends++
        },
      })
      const run = invocation(s, kind, async (_args, ctx) => {
        await Reflect.apply(ctx.session[transition]!, ctx.session, [])
        await ctx.session.send("on my replacement")
        expect(ctx.openView!({ kind: "fixture" })).toBe(true)
      })
      const running = run({
        frontend: "rpc",
        openView: () => {
          views++
          return true
        },
      })
      gate.resolve()
      expect((await running).ok).toBe(true)
      expect(sends).toBe(1)
      expect(views).toBe(1)
    })
  }
}

const nestedMethods = {
  data: ["append", "read"],
  artifacts: ["usage", "prune"],
  providerAdmin: [
    "vendors",
    "cachedVendors",
    "preview",
    "dialects",
    "exists",
    "draft",
    "storedKeyHint",
    "envIsSet",
    "listModels",
    "describeModels",
    "test",
    "save",
    "remove",
    "setKey",
  ],
  extensionAdmin: ["list", "settings", "search", "install", "update", "remove", "setEnabled"],
} satisfies {
  [K in "data" | "artifacts" | "providerAdmin" | "extensionAdmin"]: (keyof NonNullable<SessionControl[K]>)[]
}

for (const kind of kinds) {
  for (const [capability, methods] of Object.entries(nestedMethods)) {
    for (const method of methods) {
      test(`a late ${kind} cannot call retained session.${capability}.${method}`, async () => {
        let calls = 0
        const s = setup({
          [capability]: Object.freeze({
            [method]: () => {
              calls++
            },
          }),
        })
        const gate = Promise.withResolvers<void>()
        const run = invocation(s, kind, async (_args, ctx) => {
          const nested = Reflect.get(ctx.session, capability)
          const retained = Reflect.get(nested, method)
          await gate.promise
          await Reflect.apply(retained, nested, [])
        })
        const running = run({ frontend: "rpc" })
        s.host.switchTo(s.makeAgent())
        gate.resolve()
        expect((await running).ok).toBe(false)
        expect(calls).toBe(0)
      })
    }
  }
}

for (const kind of kinds) {
  test(`a stale ${kind}'s retained UI method resolves without displaying a dialog`, async () => {
    const s = setup()
    const gate = Promise.withResolvers<void>()
    let result: unknown = "pending"
    const run = invocation(s, kind, async (_args, ctx) => {
      const confirm: UiApi["confirm"] = ctx.ui.confirm
      await gate.promise
      result = await confirm("Stale question")
    })
    const running = run({ frontend: "rpc" })
    s.host.switchTo(s.makeAgent())
    gate.resolve()
    expect((await running).ok).toBe(true)
    expect(result).toBeUndefined()
    expect(s.ui.pending).toHaveLength(0)
  })
}

for (const frontend of ["rpc", "print", "tui"] as const) {
  test(`${frontend}: fresh session controls and frontend effects preserve their results`, async () => {
    const messages: ReturnType<SessionControl["messages"]> = []
    let calls = 0
    let echoes = 0
    const s = setup({
      messages: () => messages,
      models: () => ["mock/m"],
      send: async () => {
        calls++
      },
    })
    const run = invocation(s, "command", async (_args, ctx) => {
      expect(ctx.session.messages()).toBe(messages)
      expect(ctx.session.models()).toEqual(["mock/m"])
      const send = ctx.session.send
      await send("fresh")
      for (const effect of effects) {
        const result = Reflect.apply(ctx[effect]!, ctx, [{ kind: "fixture" }])
        expect(result).toBe(effect === "quit" ? undefined : true)
      }
    })
    expect(
      (
        await run({
          frontend,
          quit: () => {
            calls++
          },
          openView: () => true,
          openRewind: () => true,
          focusConversation: () => true,
          unfocusConversation: () => true,
          onSend: () => {
            echoes++
            return undefined
          },
        })
      ).ok,
    ).toBe(true)
    expect(calls).toBe(2)
    expect(echoes).toBe(1)
  })
}

test("returning to the same agent does not revive an obsolete root generation", async () => {
  let calls = 0
  const s = setup({
    send: async () => {
      calls++
    },
  })
  const original = s.host.agent
  const gate = Promise.withResolvers<void>()
  const run = invocation(s, "command", async (_args, ctx) => {
    await gate.promise
    await ctx.session.send("stale")
  })
  const running = run({ frontend: "rpc" })
  s.host.switchTo(s.makeAgent())
  s.host.switchTo(original)
  gate.resolve()
  expect((await running).ok).toBe(false)
  expect(calls).toBe(0)
})

test("another switch while an owned transition is pending permanently invalidates its caller", async () => {
  let calls = 0
  const gate = Promise.withResolvers<void>()
  const s = setup({
    newSession: async () => {
      await gate.promise
      s.host.switchTo(s.makeAgent())
    },
    send: async () => {
      calls++
    },
  })
  const run = invocation(s, "command", async (_args, ctx) => {
    await ctx.session.newSession()
    await ctx.session.send("stale")
  })
  const running = run({ frontend: "rpc" })
  s.host.switchTo(s.makeAgent())
  gate.resolve()
  expect((await running).ok).toBe(false)
  expect(calls).toBe(0)
})

test("a switch listener's replacement is not adopted by the notifying transition", async () => {
  let calls = 0
  const s = setup({
    newSession: async () => s.host.switchTo(s.makeAgent()),
    send: async () => {
      calls++
    },
  })
  const off = s.host.onSwitch(() => {
    off()
    s.host.switchTo(s.makeAgent())
  })
  const run = invocation(s, "command", async (_args, ctx) => {
    await ctx.session.newSession()
    await ctx.session.send("stale")
  })
  expect((await run({ frontend: "rpc" })).ok).toBe(false)
  expect(calls).toBe(0)
})

test("a frontend focus fence does not revoke root-scoped session controls", async () => {
  let calls = 0
  const s = setup({
    send: async () => {
      calls++
    },
  })
  const run = invocation(s, "command", (_args, ctx) => ctx.session.send("root-scoped"))
  expect((await run({ frontend: "rpc", isFrontendCurrent: () => false })).ok).toBe(true)
  expect(calls).toBe(1)
})

test("registered view factories still bind each invocation's frontend origin", async () => {
  let focus = "main"
  const shown: string[] = []
  const s = setup()
  const gate = Promise.withResolvers<void>()
  const run = invocation(s, "command", async (_args, ctx) => {
    const retained = ctx.openView!
    await gate.promise
    expect(retained({ kind: "fixture" })).toBe(false)
  })
  const openView = registerCommandViewContext(
    () => true,
    (currentRoot) => {
      const origin = focus
      return () => {
        if (!currentRoot() || focus !== origin) return false
        shown.push(origin)
        return true
      }
    },
  )
  const running = run({ frontend: "tui", openView })
  focus = "owned"
  gate.resolve()
  expect((await running).ok).toBe(true)
  expect(shown).toEqual([])
})

for (const kind of kinds) {
  test(`cancelled ${kind} context cannot start new controls, dialogs or frontend effects`, async () => {
    let sends = 0
    let quits = 0
    const s = setup({
      send: async () => {
        sends++
      },
    })
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const controller = new AbortController()
    const run = invocation(s, kind, async (_text, ctx) => {
      entered.resolve()
      await gate.promise
      ctx.quit()
      expect(await ctx.ui.confirm("obsolete question")).toBeUndefined()
      await ctx.session.send("obsolete send")
    })
    const pending = run({
      frontend: "tui",
      signal: controller.signal,
      quit: () => {
        quits++
      },
    })
    try {
      await entered.promise
      controller.abort(new Error("cancelled"))
      gate.resolve()
      expect((await pending).ok).toBe(false)
      expect(sends).toBe(0)
      expect(quits).toBe(0)
      expect(s.ui.pending).toEqual([])
    } finally {
      gate.resolve()
      await pending
      await s.host.agent.dispose()
    }
  })
}

for (const kind of kinds) {
  test(`an unrelated root switch resolves the ${kind}'s already-pending dialog without retargeting it`, async () => {
    const s = setup()
    const old = s.host.agent
    const next = s.makeAgent()
    const entered = Promise.withResolvers<void>()
    const run = invocation(s, kind, async (_text, ctx) => {
      const answer = ctx.ui.confirm("Question for old root")
      entered.resolve()
      expect(await answer).toBeUndefined()
    })
    const pending = run({ frontend: "tui" })
    try {
      await entered.promise
      expect(s.ui.pending).toHaveLength(1)
      s.host.switchTo(next)
      expect((await pending).ok).toBe(true)
      expect(s.ui.pending).toEqual([])
    } finally {
      s.ui.cancelAll()
      await pending
      await old.dispose()
      await next.dispose()
    }
  })
}
