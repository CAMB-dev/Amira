import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { userMessage } from "@amira/ai"
import { pendingOwnedGate } from "../src/file-lock-gate.ts"
import { deleteSession } from "../src/session-list.ts"
import { SessionStore, sessionLockFile } from "../src/session-store.ts"

for (const claimedChild of [true, false]) {
  test(`post-restore verification failure retains gate cleanup ownership (claimed child: ${claimedChild})`, async () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), "amira-post-restore-gate-")))
    const store = SessionStore.create({ cwd: dir, dir })
    store.appendMessage(userMessage("parent"))
    const child = SessionStore.create({ cwd: dir, dir: path.join(dir, "subagents") })
    child.appendMessage(userMessage("child"))
    store.append({ type: "subagent", childSessionId: child.id, role: "explorer" })
    if (claimedChild) child.claim()
    const parentBytes = fs.readFileSync(store.file, "utf8")
    const childBytes = fs.readFileSync(child.file, "utf8")
    const gate = `${sessionLockFile(store.file)}.lease-gate`
    const rename = fs.renameSync
    const lstat = fs.lstatSync
    let privateRoot = ""
    let renamedBack = false
    let retirementFailures = 0
    let verificationFailures = 0
    const retirementFault = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (
        path.basename(String(from)) === path.basename(gate) &&
        String(to).includes(`${path.basename(gate)}.retired-`)
      ) {
        retirementFailures++
        throw Object.assign(new Error("gate retirement sharing violation"), { code: "EPERM" })
      }
      if (String(from) === dir) privateRoot = String(to)
      const result = rename(from, to)
      if (String(from) === privateRoot && String(to) === dir) renamedBack = true
      return result
    })
    const verificationFault = spyOn(fs, "lstatSync").mockImplementation(
      (file: Parameters<typeof fs.lstatSync>[0], options?: unknown) => {
        if (renamedBack && !verificationFailures && String(file) === dir) {
          verificationFailures++
          throw Object.assign(new Error("post-restore verification sharing violation"), { code: "EPERM" })
        }
        return Reflect.apply(lstat, fs, options === undefined ? [file] : [file, options])
      },
    )
    try {
      expect(() => deleteSession(dir, store.id, undefined, dir)).toThrow()
      expect(renamedBack).toBe(true)
      expect(retirementFailures).toBeGreaterThan(0)
      expect(verificationFailures).toBe(1)
      expect(fs.readFileSync(store.file, "utf8")).toBe(parentBytes)
      expect(fs.readFileSync(child.file, "utf8")).toBe(childBytes)
      expect(fs.existsSync(gate)).toBe(true)
      expect(pendingOwnedGate(gate)).toBe(true)
      retirementFault.mockRestore()
      verificationFault.mockRestore()
      child.release()
      const deadline = Date.now() + 3000
      while (fs.existsSync(gate) && Date.now() < deadline) await Bun.sleep(10)
      expect(fs.existsSync(gate)).toBe(false)
      expect(pendingOwnedGate(gate)).toBe(false)
      store.claim()
      store.appendMessage(userMessage("write after failed verification"))
      store.release()
      expect(fs.readFileSync(store.file, "utf8")).toContain("write after failed verification")
      expect(deleteSession(dir, store.id, undefined, dir)).toEqual([store.file, child.file])
      expect(fs.existsSync(store.file)).toBe(false)
      expect(fs.existsSync(child.file)).toBe(false)
    } finally {
      retirementFault.mockRestore()
      verificationFault.mockRestore()
      child.release()
      store.release()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}
