import { expect, test } from "bun:test"
import { type EventMap, emptyUsage, type SpawnGroupInfo } from "@amira/api"
import { EventBus } from "@amira/core"
import { Spinner } from "@amira/tui-kit"
import { createSubagentBlocks } from "../src/fullscreen/subagent-blocks.ts"
import { endNode, resetGroups, type SpawnGroups, startedNode, trackGroup } from "../src/subagents.ts"

function setup() {
  const bus = new EventBus()
  const groups: SpawnGroups = new Map()
  const event = <K extends keyof EventMap>(type: K, data: EventMap[K], sessionId = "main") =>
    bus.emit(type, data, { sessionId })
  const group: SpawnGroupInfo = {
    id: "workflow",
    name: "workflow",
    parentSessionId: "main",
    state: "active",
    limits: {},
    compact: true,
    usage: emptyUsage(),
    tokens: 0,
    agents: { total: 2, working: 2, queued: 0, idle: 0, ended: 0 },
  }
  const snapshot = (info = group) => trackGroup(groups, event("group.update", { group: info }))
  const start = (id: string, info = group) =>
    startedNode(
      event(
        "subagent.start",
        {
          childSessionId: id,
          groupId: info.id,
          title: id,
          prompt: "work",
          model: { provider: "mock", model: "m1" },
          depth: info.parentSessionId === "main" ? 1 : 2,
          cwd: "/work",
          context: "fresh",
          queued: false,
        },
        info.parentSessionId,
      ),
      groups,
    )
  const end = (node: ReturnType<typeof start>, status: "done" | "error" | "aborted", note?: string) =>
    endNode(
      node,
      event("subagent.end", {
        childSessionId: node.id,
        status,
        ...(note !== undefined ? { note } : {}),
        usage: emptyUsage(),
        durationMs: 1,
      }),
      groups,
    )
  const terminal = (info = group): SpawnGroupInfo => ({
    ...info,
    state: "ended",
    agents: { ...info.agents, working: 0, ended: info.agents.total },
  })
  return { groups, group, event, snapshot, start, end, terminal }
}

test("shared group tracking deduplicates normalized member outcomes and legacy snapshots", () => {
  const { groups, group, snapshot, start, end, terminal } = setup()
  snapshot()
  const one = start("one")
  const two = start("two")
  end(one, "done", "Stopped")
  end(one, "done", "Stopped")
  end(two, "aborted")
  snapshot(terminal())
  snapshot(terminal())
  end(two, "aborted")
  expect(groups.get(group.id)?.outcomes).toEqual({ done: 0, failed: 0, stopped: 2 })
})

test("an unknown legacy end remains neutral instead of becoming success", () => {
  const { groups, group, snapshot, start, end, terminal } = setup()
  snapshot()
  const one = start("known")
  start("unknown")
  end(one, "done", "Turn limit")
  snapshot(terminal())
  expect(groups.get(group.id)?.outcomes).toEqual({ done: 0, failed: 0, stopped: 1 })
  expect(groups.get(group.id)?.agents.ended).toBe(2)
})

test("explicit outcomes win over remembered nodes and survive subsequent omissions", () => {
  const { groups, group, snapshot, start, end, terminal } = setup()
  snapshot()
  const one = start("one")
  const two = start("two")
  end(one, "done", "Stopped")
  end(two, "done", "Stopped")
  snapshot({ ...terminal(), outcomes: { done: 0, failed: 2, stopped: 0 } })
  end(one, "done", "Stopped")
  expect(groups.get(group.id)?.outcomes).toEqual({ done: 0, failed: 2, stopped: 0 })
  snapshot(terminal())
  expect(groups.get(group.id)?.outcomes).toEqual({ done: 0, failed: 2, stopped: 0 })
})

test("explicit aggregates do not double count delayed individual ends", () => {
  const { groups, group, snapshot, start, end, terminal } = setup()
  snapshot()
  const one = start("one")
  const two = start("two")
  snapshot({ ...terminal(), outcomes: { done: 0, failed: 0, stopped: 2 } })
  end(one, "done", "Stopped")
  snapshot(terminal())
  end(two, "done", "Stopped")
  snapshot(terminal())
  expect(groups.get(group.id)?.outcomes).toEqual({ done: 0, failed: 0, stopped: 2 })
})

test("a partial explicit snapshot covers delayed ends without hiding newer terminal outcomes", () => {
  const { groups, group, snapshot, start, end, terminal } = setup()
  snapshot()
  const one = start("one")
  const two = start("two")
  snapshot({
    ...group,
    agents: { ...group.agents, working: 1, ended: 1 },
    outcomes: { done: 1, failed: 0, stopped: 0 },
  })
  end(one, "done")
  end(two, "done", "Stopped")
  snapshot(terminal())
  expect(groups.get(group.id)?.outcomes).toEqual({ done: 1, failed: 0, stopped: 1 })
})

test("a stale explicit zero snapshot does not consume already known terminal identities", () => {
  const { groups, group, snapshot, start, end, terminal } = setup()
  snapshot()
  end(start("one"), "done", "Stopped")
  end(start("two"), "error")
  snapshot({ ...group, outcomes: { done: 0, failed: 0, stopped: 0 } })
  snapshot(terminal())
  expect(groups.get(group.id)?.outcomes).toEqual({ done: 0, failed: 1, stopped: 1 })
})

test("corrected explicit outcomes do not hide later members of the same outcome", () => {
  const { groups, group, snapshot, start, end } = setup()
  const active = { ...group, agents: { ...group.agents, total: 4, working: 4 } }
  snapshot(active)
  end(start("one"), "done", "Stopped")
  end(start("two"), "done", "Stopped")
  snapshot({
    ...active,
    agents: { ...active.agents, working: 2, ended: 2 },
    outcomes: { done: 0, failed: 2, stopped: 0 },
  })
  end(start("three"), "error")
  end(start("four"), "error")
  snapshot({ ...active, state: "ended", agents: { ...active.agents, working: 0, ended: 4 } })
  expect(groups.get(group.id)?.outcomes).toEqual({ done: 0, failed: 4, stopped: 0 })
})

test("nested membership survives removal of a parent and contributes to both groups", () => {
  const { groups, group, snapshot, start, end, terminal } = setup()
  snapshot()
  const parent = start("parent")
  end(parent, "error")
  const nested: SpawnGroupInfo = {
    ...group,
    id: "nested",
    parentSessionId: parent.id,
    agents: { ...group.agents, total: 1, working: 1 },
  }
  snapshot(nested)
  const child = start("child", nested)
  end(child, "done", "Stopped")
  snapshot(terminal(nested))
  snapshot(terminal())
  expect(groups.get(group.id)?.outcomes).toEqual({ done: 0, failed: 1, stopped: 1 })
  expect(groups.get(nested.id)?.outcomes).toEqual({ done: 0, failed: 0, stopped: 1 })
})

test("reset discards inferred and explicit outcomes even when a new session reuses group ids", () => {
  const { groups, group, snapshot, start, end, terminal } = setup()
  snapshot()
  end(start("member"), "error")
  snapshot({ ...terminal(), outcomes: { done: 0, failed: 2, stopped: 0 } })
  resetGroups(groups)
  snapshot()
  start("member")
  snapshot(terminal())
  expect(groups.get(group.id)?.outcomes).toEqual({ done: 0, failed: 0, stopped: 0 })
})

test("fullscreen uses the same retained legacy outcomes and resets them with its session", () => {
  const { group, event, terminal } = setup()
  const blocks = createSubagentBlocks({
    sessionId: () => "main",
    callBlock: () => undefined,
    add: () => {},
    requestRender: () => {},
    notice: () => {},
    presenters: undefined,
    spinner: new Spinner(),
    visible: () => true,
  })
  try {
    blocks.event(event("group.start", { group }))
    for (const childSessionId of ["one", "two"]) {
      blocks.event(
        event("subagent.start", {
          childSessionId,
          groupId: group.id,
          title: childSessionId,
          prompt: "work",
          model: { provider: "mock", model: "m1" },
          depth: 1,
          cwd: "/work",
          context: "fresh",
          queued: false,
        }),
      )
      blocks.event(
        event("subagent.end", {
          childSessionId,
          status: "done",
          note: "Stopped",
          usage: emptyUsage(),
          durationMs: 1,
        }),
      )
    }
    blocks.event(event("group.end", { group: terminal() }))
    expect(blocks.groups.get(group.id)?.outcomes).toEqual({ done: 0, failed: 0, stopped: 2 })
    blocks.reset()
    blocks.event(event("group.end", { group: terminal() }))
    expect(blocks.groups.get(group.id)?.outcomes).toEqual({ done: 0, failed: 0, stopped: 0 })
  } finally {
    blocks.stop()
  }
})
