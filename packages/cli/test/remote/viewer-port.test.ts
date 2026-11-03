import { expect, test } from "bun:test"
import type { AnyEvent, StoredSessionInfo, UiContext, UiControl } from "@amira/api"
import { bindLocalCommandContext } from "@amira/core"
import type { OverlayRequestBackend } from "@amira/tui"
import { VIEWER_REFUSAL } from "../../src/remote/agent-port.ts"
import { clientLabel, plainClientText, remoteAttachment } from "../../src/remote/presence.ts"
import { remotePresentationPort } from "../../src/remote/presentation-port.ts"
import { remoteSessionBrowser } from "../../src/remote/session-browser.ts"
import { until, viewerPortFixture } from "./viewer-port-fixture.ts"

test("a second auto TUI watches read-only and sends no mutation; the controller counts it", async () => {
  const f = await viewerPortFixture()
  const first = await f.open("first", {
    release: { version: "0.2.0", buildId: "amira-tui", target: "linux-x64" },
  })
  const second = await f.open("second")
  expect([first.port.role, first.port.readOnly]).toEqual(["controller", false])
  expect([second.port.role, second.port.readOnly]).toEqual(["viewer", true])
  await until(() => first.port.presence?.viewers.length === 1 && second.port.presence !== undefined)
  expect(remoteAttachment(first.port)).toEqual({ role: "controller", viewers: 1 })
  expect(remoteAttachment(second.port)).toEqual({
    role: "viewer",
    viewers: 0,
    controller: "amira-tui 0.2.0 (linux-x64)",
  })
  // Reads go to the daemon; every change is refused here, before the wire.
  expect((await second.port.execute("state.read", {})).sessionId).toBe(first.port.identity.sessionId)
  for (const run of [
    () => second.port.execute("turn.prompt", { message: "from a viewer" }),
    () => second.port.execute("turn.abort", {}),
    () => second.port.execute("permissions.cycle", {}),
    () => second.port.request("proxy.describe", {}),
    () => second.port.request("commands.complete", { line: "/re" }),
  ])
    await expect(run()).rejects.toMatchObject({ code: "not_controller", message: VIEWER_REFUSAL })
  expect(second.sent).toEqual(["state.read"])
  expect(f.runtime.workspaceSnapshot()).not.toMatchObject({ frontend: { transcript: { messages: [{}] } } })
})

test("take reconnects as controller, the old holder learns controller_taken, and watches again", async () => {
  const f = await viewerPortFixture()
  const holder = await f.open("holder")
  const taker = await f.open("taker")
  expect(taker.port.readOnly).toBe(true)
  f.advance(1_000)
  await taker.port.reconnect("take")
  expect([taker.port.role, taker.port.readOnly]).toEqual(["controller", false])
  await until(() => holder.port.status === "disconnected")
  expect((holder.port.disconnectionReason as { code?: string }).code).toBe("controller_taken")
  await holder.port.reconnect("viewer")
  expect(holder.port.role).toBe("viewer")
  await until(() => taker.port.presence?.viewers.length === 1)
  // take is one attempt: an ordinary transport reconnect after it never takes again.
  await taker.port.reconnect()
  expect(taker.port.role).toBe("controller")
  expect(holder.port.status).toBe("connected")
})

test("a refused take reports controller_busy and leaves the holder attached", async () => {
  const f = await viewerPortFixture()
  const holder = await f.open("holder")
  const taker = await f.open("taker")
  // Inside the one-second controller change rule.
  await expect(taker.port.reconnect("take")).rejects.toMatchObject({ code: "controller_busy" })
  expect(holder.port.status).toBe("connected")
  await taker.port.reconnect()
  expect(taker.port.role).toBe("viewer")
})

test("viewers act on no effect, and a promoted controller ignores replayed ones", async () => {
  const f = await viewerPortFixture()
  const holder = await f.open("holder")
  const watcher = await f.open("watcher")
  const presentation = remotePresentationPort(watcher.port)
  const effects: string[] = []
  const off = presentation.subscribeFrontendEffects((effect) => effects.push(effect.kind))
  const unbind = bindLocalCommandContext(presentation.frontend, "invocation-1", {
    frontend: "tui",
    isFrontendCurrent: () => true,
  })
  try {
    const cursor = () => watcher.port.cursor?.after ?? 0
    const before = cursor()
    f.runtime.journal.append({ kind: "effect", effect: { kind: "rewind" } })
    f.runtime.journal.append({ kind: "effect", effect: { kind: "unfocus", invocationId: "invocation-1" } })
    await until(() => cursor() >= before + 2)
    expect(effects).toEqual([])
    // Effects journaled while the connection is away come back as replay after the take.
    watcher.drop()
    await until(() => watcher.port.status === "disconnected")
    const away = cursor()
    f.runtime.journal.append({ kind: "effect", effect: { kind: "rewind" } })
    f.runtime.journal.append({ kind: "effect", effect: { kind: "detach" } })
    f.advance(1_000)
    await watcher.port.reconnect("take")
    expect(watcher.port.role).toBe("controller")
    await until(() => holder.port.status === "disconnected" && cursor() >= away + 2)
    expect(effects).toEqual([])
    f.runtime.journal.append({ kind: "effect", effect: { kind: "rewind" } })
    await until(() => effects.length === 1)
    expect(effects).toEqual(["rewind"])
  } finally {
    off()
    unbind()
    presentation.dispose()
  }
})

test("displayed client text has no terminal controls and a bounded length", () => {
  expect(plainClientText("amira\u001b]0;pwned\u0007-gui\u202E\u200B")).toBe("amira]0;pwned-gui")
  expect(plainClientText(`${"x".repeat(80)}`)).toHaveLength(48)
  expect(plainClientText(`${"x".repeat(80)}`).endsWith("…")).toBe(true)
  expect(clientLabel({ buildId: "amira-gui", target: "win32-x64", version: "1.0\u001b[31m" })).toBe(
    "amira-gui 1.0[31m (win32-x64)",
  )
  expect(clientLabel({ buildId: "\u0007", target: "" })).toBe("another client")
  // The soft hyphen and the Arabic letter mark are invisible format characters too.
  expect(plainClientText("ami­ra؜-gui")).toBe("amira-gui")
})

test("a local confirm is answered in this TUI and never reaches the daemon", async () => {
  const f = await viewerPortFixture()
  const holder = await f.open("holder")
  const presentation = remotePresentationPort(holder.port)
  const events: AnyEvent[] = []
  const off = presentation.frontend.subscribeEvents!((event) => events.push(event))
  // The subscription restores the snapshot's events in a microtask first.
  await Bun.sleep(0)
  const remote: string[] = []
  const backend = presentation.requests<OverlayRequestBackend>({
    requestState: () => "unknown",
    respond(id) {
      remote.push(id)
      return { status: "accepted" }
    },
    form: () => ({}) as never,
    settings: () => ({}) as never,
  })
  const requestIds = () =>
    events.flatMap((event) => (event.type === "ui.request" ? [event.data.requestId] : []))
  try {
    const answer = presentation.confirm("Allow remote provider mock?", "Billed locally.")
    expect(events.at(-1)).toMatchObject({
      type: "ui.request",
      data: { kind: "confirm", title: "Allow remote provider mock?", message: "Billed locally." },
    })
    const id = requestIds().at(-1)!
    expect(backend.requestState(id)).toBe("pending")
    expect(await backend.respond(id, true)).toEqual({ status: "accepted" })
    expect(await answer).toBe(true)
    expect(backend.requestState(id)).toBe("settled")
    expect(events.at(-1)).toMatchObject({ type: "ui.resolved", data: { requestId: id, cancelled: false } })
    // Other requests still go to the daemon; a dismissed or disposed local one is a no.
    expect(await backend.respond("remote-1", true)).toEqual({ status: "accepted" })
    expect(remote).toEqual(["remote-1"])
    const dismissed = presentation.confirm("Again?")
    expect(await backend.respond(requestIds().at(-1)!, undefined)).toEqual({ status: "cancelled" })
    expect(await dismissed).toBe(false)
    const open = presentation.confirm("Pending at dispose?")
    presentation.dispose()
    expect(await open).toBe(false)
    expect(await presentation.confirm("After dispose?")).toBe(false)
    expect(holder.sent).not.toContain("ui.respond")
    expect(holder.sent).not.toContain("ui.cancel")
  } finally {
    off()
    presentation.dispose()
  }
})

test("the session list stops on an empty page or an offset that does not advance", async () => {
  const session = (id: string) =>
    ({ id, title: id, updatedAt: 0, messageCount: 1 }) as unknown as StoredSessionInfo
  for (const pages of [
    [
      { sessions: [session("a")], nextOffset: 1 },
      { sessions: [], nextOffset: 2 },
    ],
    [{ sessions: [session("a")], nextOffset: 0 }],
    [
      { sessions: [session("a")], nextOffset: 1 },
      { sessions: [session("b")], nextOffset: 1 },
    ],
  ]) {
    let calls = 0
    const browser = remoteSessionBrowser({
      request: (async () => {
        if (calls >= 10) throw new Error("the list did not stop")
        return pages[Math.min(calls++, pages.length - 1)]
      }) as never,
    })
    const rendered = Promise.withResolvers<void>()
    const control = { requestRender: () => rendered.resolve() } as unknown as UiControl
    browser.onOpen!({}, control)
    await rendered.promise
    expect(calls).toBe(pages.length)
    const box = browser.ui!({}, { now: 0 } as unknown as UiContext) as { child: { items?: unknown[] } }
    expect(box.child.items).toHaveLength(pages.flatMap((page) => page.sessions).length)
    browser.dispose()
  }
})
