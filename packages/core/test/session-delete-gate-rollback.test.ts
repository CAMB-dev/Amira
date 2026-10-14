import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { userMessage } from "@amira/ai"
import { pendingOwnedGate } from "../src/file-lock-gate.ts"
import { deleteSession } from "../src/session-list.ts"
import { SessionStore, sessionLockFile } from "../src/session-store.ts"

for (const transientReadFailure of [false, true]) {
  test(`failed deletion keeps released-gate ownership across rollback (transient read: ${transientReadFailure})`, async () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), "amira-delete-gate-rollback-")))
    const store = SessionStore.create({ cwd: dir, dir })
    store.appendMessage(userMessage("parent"))
    const child = SessionStore.create({ cwd: dir, dir: path.join(dir, "subagents") })
    child.appendMessage(userMessage("claimed child"))
    store.append({ type: "subagent", childSessionId: child.id, role: "explorer" })
    child.claim()
    const parentBytes = fs.readFileSync(store.file, "utf8")
    const childBytes = fs.readFileSync(child.file, "utf8")
    const gate = `${sessionLockFile(store.file)}.lease-gate`
    const rename = fs.renameSync
    const read = fs.readFileSync
    let privateRoot = ""
    let restored = false
    let verificationFailures = 0
    const readFault = spyOn(fs, "readFileSync").mockImplementation(
      (file: Parameters<typeof fs.readFileSync>[0], options?: unknown) => {
        if (
          transientReadFailure &&
          restored &&
          !verificationFailures &&
          String(file) === path.join(gate, "owner.json")
        ) {
          verificationFailures++
          throw Object.assign(new Error("metadata sharing violation"), { code: "EPERM" })
        }
        return Reflect.apply(read, fs, options === undefined ? [file] : [file, options])
      },
    )
    let faults = 0
    const fault = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(from) === dir) privateRoot = String(to)
      if (String(from) === privateRoot && String(to) === dir) restored = true
      if (
        path.basename(String(from)) === path.basename(gate) &&
        String(to).includes(`${path.basename(gate)}.retired-`)
      ) {
        faults++
        throw Object.assign(new Error("gate retirement sharing violation"), { code: "EPERM" })
      }
      return rename(from, to)
    })
    try {
      expect(() => deleteSession(dir, store.id, undefined, dir)).toThrow("open")
      expect(faults).toBeGreaterThan(0)
      expect(fs.readFileSync(store.file, "utf8")).toBe(parentBytes)
      expect(fs.readFileSync(child.file, "utf8")).toBe(childBytes)
      // The retirement fault is still active: rollback must retain its exact cleanup owner.
      expect(fs.existsSync(gate)).toBe(true)
      expect(pendingOwnedGate(gate)).toBe(true)
      expect(verificationFailures).toBe(transientReadFailure ? 1 : 0)
      fault.mockRestore()
      readFault.mockRestore()
      child.release()
      const deadline = Date.now() + 3000
      while (fs.existsSync(gate) && Date.now() < deadline) await Bun.sleep(10)
      expect(fs.existsSync(gate)).toBe(false)
      expect(pendingOwnedGate(gate)).toBe(false)
      store.claim()
      store.appendMessage(userMessage("write after rollback"))
      store.release()
      expect(fs.readFileSync(store.file, "utf8")).toContain("write after rollback")
      expect(deleteSession(dir, store.id, undefined, dir)).toEqual([store.file, child.file])
      expect(fs.existsSync(store.file)).toBe(false)
      expect(fs.existsSync(child.file)).toBe(false)
    } finally {
      fault.mockRestore()
      readFault.mockRestore()
      child.release()
      store.release()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}
