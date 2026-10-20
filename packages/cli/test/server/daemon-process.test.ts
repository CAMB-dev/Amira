import "./offline.ts"
import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { SPAWN_TEST_TIMEOUT_MS, stopSpawn, waitForSpawnWork } from "../../../../scripts/spawn-test.ts"
import { RemoteConnection } from "../../src/remote/connection.ts"
import type { RemoteWelcome } from "../../src/remote/protocol.ts"
import { hello } from "../remote/loopback.ts"

test(
  "harness-owned workspace process survives separate local fake-SSH relay lifetimes",
  async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "amira-daemon-process-"))
    const remoteHome = path.join(root, "remote")
    const cwd = path.join(root, "workspace")
    for (const dir of [remoteHome, cwd, path.join(root, "local")]) mkdirSync(dir)
    const entry = path.join(import.meta.dir, "daemon-process-worker.ts")
    const ready = Promise.withResolvers<void>()
    const inspect = new Map<string, (result: { snapshot: unknown; idle: boolean }) => void>()
    const relays = new Map<string, Bun.Subprocess<"pipe", "pipe", "pipe">>()
    const owner = Bun.spawn([process.execPath, entry, "runtime", cwd], {
      env: { ...process.env, AMIRA_HOME: remoteHome, HOME: remoteHome, USERPROFILE: remoteHome },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ipc(message: { kind: string; id: string; bytes: string; snapshot: unknown; idle: boolean }) {
        if (message.kind === "ready") ready.resolve()
        else if (message.kind === "bytes") relays.get(message.id)?.send({ bytes: message.bytes })
        else inspect.get(message.id)?.(message)
      },
    })
    const ownerOut = new Response(owner.stdout).text()
    const ownerErr = new Response(owner.stderr).text()
    async function snapshot() {
      const id = crypto.randomUUID()
      const result = Promise.withResolvers<{ snapshot: unknown; idle: boolean }>()
      inspect.set(id, result.resolve)
      owner.send({ action: "inspect", id })
      try {
        return await waitForSpawnWork("owner state", result.promise)
      } finally {
        inspect.delete(id)
      }
    }
    function connect(id: string, welcome?: RemoteWelcome) {
      owner.send({ action: "connect", id })
      const relay = Bun.spawn([process.execPath, entry, "relay"], {
        env: process.env,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        ipc(message: { bytes: string }) {
          owner.send({ action: "bytes", id, bytes: message.bytes })
        },
      })
      relays.set(id, relay)
      const errors = new Response(relay.stderr).text()
      void relay.exited.then(() => {
        owner.send({ action: "close", id })
      })
      const client = new RemoteConnection(
        {
          input: relay.stdout,
          async write(bytes) {
            relay.stdin.write(bytes)
            await relay.stdin.flush()
          },
          close() {
            relay.stdin.end()
          },
        },
        {
          handshake: {
            role: "client",
            hello: {
              ...hello,
              workspace: cwd,
              snapshot: true,
              ...(welcome
                ? {
                    resume: {
                      daemonEpoch: welcome.daemonEpoch,
                      after: 0,
                      controllerToken: welcome.controllerToken!,
                    },
                  }
                : {}),
            },
          },
        },
      )
      return { relay, client, errors }
    }
    try {
      await waitForSpawnWork("runtime readiness", ready.promise)
      const first = connect("one")
      const welcome = await waitForSpawnWork("first attach", first.client.ready)
      await first.client.request("turn.prompt", { message: "finish without relay" })
      first.client.close()
      expect(await waitForSpawnWork("relay EOF", first.relay.exited)).toBe(0)
      expect(await first.errors).toBe("")
      expect(owner.exitCode).toBeNull()
      let state = await snapshot()
      const until = Date.now() + 10_000
      while (!state.idle && Date.now() < until) {
        await Bun.sleep(10)
        state = await snapshot()
      }
      expect(state.idle).toBe(true)
      expect(JSON.stringify(state.snapshot)).toContain("persistent process result")
      const second = connect("two", welcome)
      expect((await waitForSpawnWork("second attach", second.client.ready)).daemonEpoch).toBe(
        welcome.daemonEpoch,
      )
      second.client.close()
      expect(await waitForSpawnWork("second relay EOF", second.relay.exited)).toBe(0)
      expect(await second.errors).toBe("")
      owner.send({ action: "stop" })
      expect(await waitForSpawnWork("owner stop", owner.exited)).toBe(0)
      expect(await ownerOut).toBe("")
      expect(await ownerErr).toBe("")
    } finally {
      for (const relay of relays.values()) await stopSpawn(relay)
      await stopSpawn(owner)
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)
