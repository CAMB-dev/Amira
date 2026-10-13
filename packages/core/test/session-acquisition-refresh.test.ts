import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect, userMessage } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { SessionStore, sessionLockFile } from "../src/session-store.ts"

for (const code of ["EACCES", "EPERM", "EBUSY"]) {
  for (const view of ["unclaimed", "same owner", "new owned view"] as const) {
    test(`refresh ${code} is synchronous and preserves original error/refs (${view})`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amira-acquire-refresh-"))
      const store = SessionStore.create({ cwd: dir, dir })
      store.appendMessage(userMessage("saved history"))
      const ai = createAi({
        dialects: [createMockDialect([])],
        providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      })
      const owner =
        view === "unclaimed"
          ? undefined
          : new Agent({ ai, model: ai.model("mock/m"), cwd: dir, session: store })
      const target = view === "new owned view" ? SessionStore.open(store.file) : store
      const read = fs.readFileSync
      const failure = Object.assign(new Error(`${code}: history read ${store.file}`), {
        code,
        path: store.file,
      })
      const hook = spyOn(fs, "readFileSync").mockImplementation(
        new Proxy(read, {
          apply(target, receiver, args) {
            if (String(args[0]) === store.file) throw failure
            return Reflect.apply(target, receiver, args)
          },
        }),
      )
      const timers = spyOn(globalThis, "setTimeout")
      let constructed = 0
      let pending: unknown
      try {
        let syncError: unknown
        try {
          target.claim()
        } catch (error) {
          syncError = error
        }
        expect(syncError).toBe(failure)
        let awaitedError: unknown
        try {
          pending = target.withClaim(
            () => {
              constructed++
              return new Agent({ ai, model: ai.model("mock/m"), cwd: dir, session: target })
            },
            { waitMs: 20 },
          )
        } catch (error) {
          awaitedError = error
        }
        // Settle a faulty retry before cleanup, retaining the synchronous-boundary assertion.
        if (pending instanceof Promise) await pending.catch(() => {})
        expect(awaitedError).toBe(failure)
        expect(timers).not.toHaveBeenCalled()
        expect(constructed).toBe(0)
        expect(fs.existsSync(sessionLockFile(store.file))).toBe(!!owner)
        hook.mockRestore()
        if (owner) {
          store.appendDisplay({ type: "display", text: "owner still writes", level: "info" })
          expect(SessionStore.open(store.file).entries.at(-1)).toMatchObject({ text: "owner still writes" })
        }
        await owner?.dispose()
        expect(fs.existsSync(sessionLockFile(store.file))).toBe(false)
      } finally {
        hook.mockRestore()
        timers.mockRestore()
        await owner?.dispose()
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  }
}
