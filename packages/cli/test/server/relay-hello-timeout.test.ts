import "./offline.ts"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { SPAWN_TEST_TIMEOUT_MS, stopSpawn, waitForSpawnWork } from "../../../../scripts/spawn-test.ts"
import type { RemoteIO } from "../../src/remote/connection.ts"
import { validateRemoteFrame } from "../../src/remote-schema.ts"
import { attachWorkspace } from "../../src/server/attach.ts"
import type { DaemonPlatform } from "../../src/server/platform.ts"
import { release } from "./daemon-fixture.ts"

/** A relay stdin that never delivers a byte; closing it either ends the read with an error or not at all. */
function silentStdio(closeRejects: boolean) {
  const written: string[] = []
  let closed = false
  let fail: ((error: Error) => void) | undefined
  const io: RemoteIO = {
    input: {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<Uint8Array>>((_, reject) => {
            fail = reject
          }),
      }),
    },
    async write(bytes) {
      // Writes after close would be lost on a real pipe.
      if (closed) throw new Error("write after close")
      written.push(new TextDecoder().decode(bytes))
    },
    close() {
      closed = true
      if (closeRejects)
        fail?.(Object.assign(new Error("Premature close"), { code: "ERR_STREAM_PREMATURE_CLOSE" }))
    },
  }
  return { io, written, closed: () => closed }
}

const unused = () => {
  throw new Error("A relay without a hello must not discover or start a daemon")
}

for (const closeRejects of [false, true]) {
  test(`a relay with no hello writes a typed reject, then closes (close ${closeRejects ? "rejects" : "hangs"} the read)`, async () => {
    const stdio = silentStdio(closeRejects)
    await attachWorkspace({
      io: stdio.io,
      discovery: unused,
      platform: { processIdentity: unused } as unknown as DaemonPlatform,
      release,
      helloTimeoutMs: 20,
    })
    expect(stdio.closed()).toBe(true)
    expect(stdio.written).toHaveLength(1)
    const reject = validateRemoteFrame(JSON.parse(stdio.written[0]!))
    expect(reject).toEqual({
      v: 1,
      kind: "reject",
      error: { code: "invalid_frame", message: "Remote handshake timed out" },
    })
  })
}

// The relay entry is Linux-only (LinuxDaemonPlatform); other platforms run the stdio tests above.
test.skipIf(process.platform !== "linux")(
  "the amira-server attach process answers a silent client with one reject line and exits",
  async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "amira-relay-timeout-"))
    let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined
    try {
      child = Bun.spawn(
        [process.execPath, path.join(import.meta.dir, "../../src/server-main.ts"), "attach", "--remote-key"],
        {
          env: { ...process.env, AMIRA_HOME: home, HOME: home, USERPROFILE: home, XDG_RUNTIME_DIR: home },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const stdout = new Response(child.stdout).text()
      const started = Date.now()
      const code = await waitForSpawnWork("relay exit", child.exited)
      child.stdin.end()
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_000)
      expect(code).toBe(0)
      const lines = (await stdout).split("\n")
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]!)).toEqual({
        v: 1,
        kind: "reject",
        error: { code: "invalid_frame", message: "Remote handshake timed out" },
      })
    } finally {
      if (child) await stopSpawn(child, "relay")
      rmSync(home, { recursive: true, force: true, maxRetries: 3 })
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)
