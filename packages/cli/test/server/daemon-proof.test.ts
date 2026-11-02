import "./offline.ts"
import { expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import type { RemoteIO } from "../../src/remote/connection.ts"
import { DaemonProofError, proveClient, proveToDaemon } from "../../src/server/daemon-proof.ts"
import { privateMessage, readPrivatePrelude } from "../../src/server/private-ipc.ts"
import { loopback } from "../remote/loopback.ts"

const pipe = "\\\\.\\pipe\\amira-0123456789abcdef0123456789abcdef"
const key = "4f9c2a6e-1b7d-4c3e-9a8f-2d6b5e4c3a21"
const mac = (role: string, endpoint: string, client: string, server: string, secret = key) =>
  createHmac("sha256", secret).update(`amira-daemon/${role}\0${endpoint}\0${client}\0${server}`).digest("hex")

/** Records every line one side wrote, so a test can show what never left the client. */
function recorded(io: RemoteIO) {
  const lines: unknown[] = []
  return {
    lines,
    io: {
      ...io,
      write: async (bytes: Uint8Array) => {
        for (const line of Buffer.from(bytes).toString("utf8").split("\n"))
          if (line) lines.push(JSON.parse(line))
        await io.write(bytes)
      },
    } satisfies RemoteIO,
  }
}

async function after(io: RemoteIO): Promise<unknown> {
  return (await readPrivatePrelude(io)).value
}

test("both sides prove the nonce over the pipe name and both challenges, then hand over the stream", async () => {
  const pipes = loopback(7)
  const client = recorded(pipes.client)
  const server = recorded(pipes.server)
  const [clientTail, serverTail] = await Promise.all([
    proveToDaemon(client.io, pipe, key),
    proveClient(server.io, pipe, key),
  ])
  const [request, reply] = [client.lines[0] as { c: string }, server.lines[0] as { s: string; p: string }]
  expect(Object.keys(request).sort()).toEqual(["auth", "c"])
  expect(request.c).toMatch(/^[0-9a-f]{64}$/)
  expect(reply.p).toBe(mac("server", pipe, request.c, reply.s))
  expect(client.lines[1]).toEqual({ auth: 1, p: mac("client", pipe, request.c, reply.s) })
  // Nothing in the transcript is the key itself.
  expect(JSON.stringify([...client.lines, ...server.lines])).not.toContain(key)
  await privateMessage(clientTail, { action: "probe" })
  expect(await after(serverTail)).toEqual({ action: "probe" })
  await privateMessage(serverTail, { ok: true })
  expect(await after(clientTail)).toEqual({ ok: true })
})

/** A fake daemon answering the client's challenge with `reply`; returns what the client sent. */
async function fakeServer(reply: (challenge: string) => unknown) {
  const pipes = loopback()
  const client = recorded(pipes.client)
  const proof = proveToDaemon(client.io, pipe, key)
  const { value } = await readPrivatePrelude(pipes.server)
  const answer = reply((value as { c: string }).c)
  if (typeof answer === "string") await pipes.server.write(Buffer.from(answer))
  else if (answer !== undefined) await privateMessage(pipes.server, answer)
  else pipes.server.close()
  await expect(proof).rejects.toBeInstanceOf(DaemonProofError)
  return client.lines
}

test("the client refuses a wrong key, a replay for another pipe, tampering, oversize and early EOF", async () => {
  const s = "ab".repeat(32)
  const cases: ((c: string) => unknown)[] = [
    (c) => ({ auth: 1, s, p: mac("server", pipe, c, s, "another-nonce") }),
    (c) => ({ auth: 1, s, p: mac("server", `${pipe.slice(0, -1)}0`, c, s) }),
    (c) => ({ auth: 1, s, p: mac("client", pipe, c, s) }),
    (c) => ({ auth: 1, s: "cd".repeat(32), p: mac("server", pipe, c, s) }),
    (c) => ({ auth: 1, s, p: mac("server", pipe, c, s), extra: true }),
    (c) => ({ auth: 2, s, p: mac("server", pipe, c, s) }),
    (c) => ({ auth: 1, s, p: mac("server", pipe, c, s).toUpperCase() }),
    () => `${JSON.stringify({ auth: 1, s, p: "0".repeat(2048) })}\n`,
    () => "not json\n",
    () => undefined,
  ]
  for (const reply of cases) {
    const sent = await fakeServer(reply)
    // The client never answers an unproven server.
    expect(sent).toHaveLength(1)
    expect(Object.keys(sent[0] as object).sort()).toEqual(["auth", "c"])
  }
})

test("the client gives up on a silent server as an unverified, retryable connection", async () => {
  const pipes = loopback()
  const error = await proveToDaemon(pipes.client, pipe, key).catch((e) => e)
  expect(error).toBeInstanceOf(DaemonProofError)
  expect(error.code).toBe("disconnected")
}, 15_000)

test("the server refuses a client that cannot prove the key or replays another transcript", async () => {
  const run = async (respond: (reply: { s: string; p: string }, c: string) => unknown, first?: unknown) => {
    const pipes = loopback()
    const server = proveClient(pipes.server, pipe, key)
    const c = "12".repeat(32)
    await privateMessage(pipes.client, first ?? { auth: 1, c })
    if (first) return expect(server).rejects.toThrow()
    const reply = (await readPrivatePrelude(pipes.client)).value as { s: string; p: string }
    await privateMessage(pipes.client, respond(reply, c))
    return expect(server).rejects.toThrow()
  }
  await run((r, c) => ({ auth: 1, p: mac("client", pipe, c, r.s, "wrong") }))
  await run((r, c) => ({ auth: 1, p: mac("server", pipe, c, r.s) }))
  await run((r, c) => ({ auth: 1, p: mac("client", `${pipe.slice(0, -1)}0`, c, r.s) }))
  await run(() => ({ auth: 1, p: "00" }))
  await run(() => ({ auth: 1 }))
  await run(() => ({}), { auth: 1, c: "short" })
  await run(() => ({}), { auth: 1, c: "12".repeat(32), nonce: key })
  await run(() => ({}), { action: "probe", nonce: key })
})
