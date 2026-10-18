import { expect, test } from "bun:test"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import type { SessionControl } from "@amira/api"
import {
  Agent,
  type AgentPort,
  CommandHost,
  CommandRegistry,
  createLocalAgentPort,
  EventBus,
  UiRequests,
} from "@amira/core"
import { Editor, key } from "@amira/tui-kit"
import { localCommandContext } from "../../core/src/frontend/operations.ts"
import { createCommandRunner } from "../src/app/command-runner.ts"
import { RewindFlow } from "../src/app/rewind.ts"
import { createSubmission } from "../src/app/submission.ts"
import type { Dialog } from "../src/dialog.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"

function fixture(extra: Partial<SessionControl> = {}) {
  const ai = createAi({
    dialects: [createMockDialect([])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const bus = new EventBus()
  const agent = new Agent({ ai, model: ai.model("mock/m"), bus, cwd: process.cwd() })
  const registry = new CommandRegistry()
  const commands = new CommandHost({
    registry,
    bus,
    ui: new UiRequests(bus),
    agent,
    control: { info: () => ({ id: agent.sessionId, busy: false }), ...extra } as SessionControl,
  })
  const port = createLocalAgentPort({ agent, commands })
  return { agent, commands, registry, port }
}

function runner(port: AgentPort, commands?: CommandHost) {
  const output: string[] = []
  const echoes: string[] = []
  let quits = 0
  const instance = createCommandRunner({
    port,
    commands,
    keys: new Keybindings(defaultKeys({ vscode: false })),
    reaches: () => true,
    commandEcho: (line) => echoes.push(line),
    commandOutput: (_, text) => output.push(text),
    requestRender: () => {},
    animationChanged: () => {},
    sessionId: () => port.snapshot.state.sessionId,
    quit: () => void quits++,
    openView: () => false,
    openRewind: () => false,
    isCompacting: () => false,
    interrupt: () => {},
  })
  return { instance, output, echoes, quits: () => quits }
}

test("port commands retain local callbacks and echo correlation without putting functions in params", async () => {
  const s = fixture()
  const r = runner(s.port, s.commands)
  let invocationId: string | undefined
  const execute = s.port.execute.bind(s.port)
  s.port.execute = async (operation, params, options) => {
    if (operation === "command.run" && "invocationId" in params) {
      invocationId = params.invocationId
      expect(JSON.parse(JSON.stringify(params))).toEqual(params)
      expect(options?.sessionGeneration).toBe(1)
      expect(options?.signal).toBeInstanceOf(AbortSignal)
      const context = localCommandContext(s.port, invocationId)!
      context.quit?.()
      context.onSend?.("Expanded task", { display: { text: "/task" } })
    }
    return execute(operation, params, options)
  }
  s.registry.register({ name: "task", description: "Task", run: () => {} }, "test")
  try {
    await r.instance.run("/task")
    expect(r.quits()).toBe(1)
    expect(r.echoes).toEqual(["/task"])
    expect(r.output).toEqual([])
    expect(localCommandContext(s.port, invocationId)).toBeUndefined()
    const prompt = JSON.parse(JSON.stringify(userMessage("Expanded task", { text: "/task" })))
    expect(r.instance.takeEcho(prompt)).toBe(true)
    expect(r.instance.takeEcho(prompt)).toBe(false)
  } finally {
    await s.port.detach()
    await s.agent.dispose("exit")
  }
})

test("a settled local command stops consuming cancellation before its port acknowledgement", async () => {
  const s = fixture()
  const r = runner(s.port, s.commands)
  const acknowledgement = Promise.withResolvers<void>()
  const settled = Promise.withResolvers<void>()
  const execute = s.port.execute.bind(s.port)
  s.port.execute = async (operation, params, options) => {
    const result = await execute(operation, params, options)
    settled.resolve()
    await acknowledgement.promise
    return result
  }
  s.registry.register({ name: "view", description: "View", run: () => {} }, "test")
  const running = r.instance.run("/view")
  try {
    await settled.promise
    expect(r.instance.hasCancellable()).toBe(false)
    expect(r.instance.animationActive).toBe(false)
    expect(r.instance.cancel()).toBe(false)
  } finally {
    acknowledgement.resolve()
    await running
    await s.port.detach()
    await s.agent.dispose("exit")
  }
})

for (const action of ["error", "stale", "cancel"] as const) {
  test(`command ${action} acknowledgements clean up activity and isolate stale failures`, async () => {
    const s = fixture()
    const pending = Promise.withResolvers<never>()
    let generation = 1
    let signal: AbortSignal | undefined
    const port: AgentPort = {
      get snapshot() {
        return { ...s.port.snapshot, sessionGeneration: generation }
      },
      subscribe: () => () => {},
      execute: async (_, __, options) => {
        signal = options?.signal
        return pending.promise
      },
      detach: async () => {},
    }
    const r = runner(port)
    try {
      const running = r.instance.run("/task")
      expect(r.instance.hasCancellable()).toBe(true)
      if (action === "cancel") {
        expect(r.instance.cancel()).toBe(true)
        expect(signal?.aborted).toBe(true)
      } else if (action === "stale") generation++
      pending.reject(new Error("Disconnected"))
      await running
      expect(r.output).toEqual(action === "error" ? ["Disconnected"] : [])
      expect(r.instance.hasCancellable()).toBe(false)
      expect(r.instance.animationActive).toBe(false)
    } finally {
      await s.port.detach()
      await s.agent.dispose("exit")
    }
  })
}

test("skill transport rejection is handled and its local presentation binding released", async () => {
  const s = fixture()
  const output: string[] = []
  const done = Promise.withResolvers<void>()
  let invocationId: string | undefined
  const port: AgentPort = {
    get snapshot() {
      return s.port.snapshot
    },
    subscribe: () => () => {},
    execute: async (operation, params) => {
      expect(String(operation)).toBe("skill.run")
      if ("invocationId" in params) invocationId = params.invocationId
      expect(localCommandContext(port, invocationId)?.frontend).toBe("tui")
      throw new Error("Disconnected")
    },
    detach: async () => {},
  }
  const submission = createSubmission({
    port,
    agent: () => s.agent,
    editor: {
      clear: () => {},
      setParts: () => {},
      getText: () => "",
      getParts: () => [],
      getDisplayText: () => "",
    },
    history: { add: () => {} },
    composer: { clipboardPending: false, resetHistory: () => {} },
    commandRunner: { run: async () => {} },
    outbox: { prepare: () => ({ text: "" }), dispatch: () => {} },
    view: {
      notice: (_, text) => output.push(text),
      commandEcho: () => {},
      requestRender: () => done.resolve(),
    },
    enterDoes: "queue",
    context: { frontend: "tui" },
  })
  try {
    submission.runSkill("$task")
    await done.promise
    expect(output).toEqual(["Disconnected"])
    expect(localCommandContext(port, invocationId)).toBeUndefined()
  } finally {
    await s.port.detach()
    await s.agent.dispose("exit")
  }
})

function rewindFixture(port: AgentPort) {
  const dialogs: Dialog[] = []
  const editor = new Editor()
  const notices: string[] = []
  const flow = new RewindFlow({
    port,
    agent: () => {
      throw new Error("Rewind should read the port snapshot")
    },
    dialogs,
    keys: new Keybindings(defaultKeys({ vscode: false })),
    editor,
    sentParts: new Map(),
    working: () => false,
    compacting: () => false,
    showNote: (text) => notices.push(text),
    view: { notice: (_, text) => notices.push(text), requestRender: () => {} },
    redraw: () => {},
    waitingChanged: () => {},
  })
  return { flow, dialogs, editor, notices }
}

for (const fork of [false, true]) {
  test(`port ${fork ? "fork" : "rewind"} acknowledges before restoring the selected draft`, async () => {
    const pending = Promise.withResolvers<void>()
    let index: number | undefined
    const s = fixture({
      fork: async (at) => {
        index = at
        await pending.promise
      },
      rewind: async (at) => {
        index = at
        await pending.promise
      },
      planRewind: () => ({
        owner: "core",
        enabled: false,
        restored: 0,
        removed: 0,
        conflicts: [],
        note: "No files",
      }),
    })
    s.agent.messages.push(userMessage("Recover this"))
    s.commands.switchTo(s.agent)
    const r = rewindFixture(s.port)
    try {
      expect(r.flow.openRewind()).toBe(true)
      r.dialogs[0]!.handleInput(key(fork ? "f" : "enter"))
      await Bun.sleep(0)
      if (!fork) r.dialogs[0]!.handleInput(key("enter"))
      expect(index).toBe(0)
      expect(r.editor.isEmpty).toBe(true)
      pending.resolve()
      await Bun.sleep(0)
      expect(r.editor.getText()).toBe("Recover this")
      expect(r.notices.some((text) => text.includes(fork ? "Forked" : "Rewound"))).toBe(true)
    } finally {
      pending.resolve()
      await s.port.detach()
      await s.agent.dispose("exit")
    }
  })
}

test("late rewind plans from a replaced session neither open confirmation nor report failure", async () => {
  const pending = Promise.withResolvers<void>()
  const s = fixture({
    planRewind: () => ({
      owner: "core",
      enabled: false,
      restored: 0,
      removed: 0,
      conflicts: [],
      note: "No files",
    }),
  })
  s.agent.messages.push(userMessage("Old session prompt"))
  s.commands.switchTo(s.agent)
  const execute = s.port.execute.bind(s.port)
  s.port.execute = async (operation, params, options) => {
    const result = await execute(operation, params, options)
    if (operation === "session.planRewind") await pending.promise
    return result
  }
  const r = rewindFixture(s.port)
  try {
    expect(r.flow.openRewind()).toBe(true)
    r.dialogs[0]!.handleInput(key("enter"))
    s.commands.switchTo(s.agent)
    pending.resolve()
    await Bun.sleep(0)
    expect(r.dialogs).toHaveLength(0)
    expect(r.notices).toEqual([])
    expect(r.editor.isEmpty).toBe(true)
  } finally {
    pending.resolve()
    await s.port.detach()
    await s.agent.dispose("exit")
  }
})

test("new recovery commands use current authority when the last display snapshot belongs to an old session", async () => {
  const first = fixture()
  const broken = fixture()
  const r = runner(first.port, first.commands)
  let runs = 0
  broken.agent.messages.push({
    role: "toolResult",
    toolCallId: "bad",
    toolName: "bad",
    content: [],
    isError: true,
    details: Number.POSITIVE_INFINITY,
  })
  first.registry.register(
    {
      name: "recover",
      description: "Recover",
      run: () => {
        runs++
        first.commands.switchTo(first.agent)
      },
    },
    "test",
  )
  const snapshot = first.port.snapshot
  try {
    first.commands.switchTo(broken.agent)
    expect(first.port.snapshot).toBe(snapshot)
    await r.instance.run("/recover")
    expect(runs).toBe(1)
    expect(r.output).toEqual([])
    expect(first.port.snapshot.sessionGeneration).toBe(3)
  } finally {
    await first.port.detach()
    await broken.port.detach()
    await first.agent.dispose("exit")
    await broken.agent.dispose("exit")
  }
})

test("fresh authority cannot authorize rewind/fork choices from an old failed projection", async () => {
  const first = fixture({ rewind: async () => {}, fork: async () => {} })
  const broken = fixture()
  first.agent.messages.push(userMessage("Old session A choice"))
  first.commands.switchTo(first.agent)
  broken.agent.messages.push(userMessage("Different session B choice"), {
    role: "toolResult",
    toolCallId: "bad",
    toolName: "bad",
    content: [],
    isError: true,
    details: Number.POSITIVE_INFINITY,
  })
  const r = rewindFixture(first.port)
  try {
    first.commands.switchTo(broken.agent)
    expect(r.flow.openRewind()).toBe(false)
    expect(r.dialogs).toEqual([])
  } finally {
    await first.port.detach()
    await broken.port.detach()
    await first.agent.dispose("exit")
    await broken.agent.dispose("exit")
  }
})
