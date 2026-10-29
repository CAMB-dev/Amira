import { rmSync } from "node:fs"
import { createAi, createMockDialect } from "@amira/ai"
import { attachWorkspace } from "../../src/server/attach.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import { discoveryFixture, FakeDaemonPlatform, release } from "../server/daemon-fixture.ts"
import { loopback } from "./loopback.ts"

type Frame = { [key: string]: any }
export type WireLine = { from: "client" | "server"; frame: Frame }

/**
 * A third-party client in miniature: raw JSON lines over the `amira-server attach` stdio relay,
 * which discovers or starts the daemon. No Amira client code (RemoteConnection, codec) is used.
 * The daemon platform is the in-process fake: no sockets, SSH, network or real provider.
 */
export async function rawClientSession(answer = "Hello from the mock model.") {
  const f = discoveryFixture()
  const dialect = createMockDialect([{ text: answer }])
  const platform = new FakeDaemonPlatform(f.discovery, (cwd) =>
    createWorkspaceRuntime({
      cwd,
      autoTitle: false,
      model: "mock/test",
      ai: createAi({ dialects: [dialect], providers: [{ id: "mock", dialect: "mock", baseUrl: "" }] }),
      builtins: async () => [],
    }),
  )
  const pipes = loopback()
  const relay = attachWorkspace({ io: pipes.server, discovery: () => f.discovery, platform, release })
  const wire: WireLine[] = []
  const inbox: Frame[] = []
  let wake: (() => void) | undefined
  let ended = false
  void (async () => {
    let buffered = ""
    for await (const bytes of pipes.client.input) {
      buffered += Buffer.from(bytes).toString("utf8")
      for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
        const frame = JSON.parse(buffered.slice(0, end)) as Frame
        buffered = buffered.slice(end + 1)
        wire.push({ from: "server", frame })
        inbox.push(frame)
        wake?.()
      }
    }
    ended = true
    wake?.()
  })()
  const send = async (frame: Frame) => {
    wire.push({ from: "client", frame })
    await pipes.client.write(Buffer.from(`${JSON.stringify(frame)}\n`))
  }
  /** The next server frame matching check; earlier non-matching frames stay recorded in wire. */
  const next = async (check: (frame: Frame) => boolean, label: string): Promise<Frame> => {
    const until = Date.now() + 15_000
    while (true) {
      const index = inbox.findIndex(check)
      if (index >= 0) return inbox.splice(0, index + 1).at(-1)!
      if (ended || Date.now() > until) throw new Error(`Raw client did not receive ${label}`)
      await new Promise<void>((resolve) => {
        wake = resolve
        setTimeout(resolve, 50)
      })
    }
  }
  return {
    wire,
    send,
    next,
    workspace: f.cwd,
    async close() {
      pipes.client.close()
      await relay
      await platform.daemon?.stop()
      rmSync(f.root, { recursive: true, force: true, maxRetries: 3 })
    },
  }
}

export const exampleHello = (workspace: string) => ({
  v: 1,
  kind: "hello",
  clientId: "example-gui-1",
  workspace,
  release: { version: "0.1.0", buildId: "example-gui", target: "win32-x64" },
  limits: { lineBytes: 262144, logicalBytes: 67108864 },
  capabilities: ["context-window-source.provider"],
})

/** hello -> welcome -> reset -> state.read -> turn.prompt -> events until turn.end -> ack. */
export async function exampleExchange(session: Awaited<ReturnType<typeof rawClientSession>>) {
  await session.send(exampleHello(session.workspace))
  const welcome = await session.next((frame) => frame.kind === "welcome", "welcome")
  await session.next((frame) => frame.kind === "reset", "reset")
  const envelope = {
    v: 1,
    kind: "request",
    channel: "control",
    daemonEpoch: welcome.daemonEpoch,
    controllerGeneration: welcome.controllerGeneration,
    sessionGeneration: welcome.sessionGeneration,
  }
  await session.send({ ...envelope, id: "1", op: "state.read", params: {} })
  const state = await session.next((frame) => frame.kind === "response" && frame.id === "1", "state.read")
  await session.send({ ...envelope, id: "2", op: "turn.prompt", params: { message: "Say hello." } })
  await session.next((frame) => frame.kind === "response" && frame.id === "2", "turn.prompt")
  const end = await session.next(
    (frame) => frame.kind === "event" && frame.payload.type === "turn.end",
    "turn.end event",
  )
  await session.send({ v: 1, kind: "ack", channel: "control", id: welcome.daemonEpoch, seq: end.seq })
  return { welcome, state, end }
}
