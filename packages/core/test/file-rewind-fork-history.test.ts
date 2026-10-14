import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { userMessage } from "@amira/ai"
import { copyFileHistory, FileRewind } from "../src/file-rewind.ts"
import { SessionStore } from "../src/session-store.ts"

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

for (const external of [false, true]) {
  test(`forking at an earlier target retains later physical file history (external: ${external})`, async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "amira-fork-file-history-")))
    dirs.push(dir)
    const file = join(dir, "a")
    writeFileSync(file, "original")
    const store = SessionStore.create({ cwd: dir, dir: join(dir, "sessions") })
    const rewind = new FileRewind(store)
    const write = async (content: string) =>
      rewind.mutate([{ path: file, after: Buffer.from(content) }], async () => writeFileSync(file, content), {
        sessionId: store.id,
        toolCallId: "write",
        turnId: "turn",
      })
    const first = store.appendMessage(userMessage("first"))
    await write("first")
    const second = store.appendMessage(userMessage("second"))
    await write("second")
    const forked = store.fork(store.get(second)!.parentId)
    copyFileHistory(store, forked)
    const recorder = new FileRewind(SessionStore.open(forked.file))
    expect(recorder.store.restore().messages).toEqual([userMessage("first")])
    if (external) writeFileSync(file, "first")
    expect(recorder.plan(first).conflicts).toEqual(external ? [file] : [])
    if (external) {
      expect(() => recorder.restore(first, null)).toThrow("nothing changed")
      expect(readFileSync(file, "utf8")).toBe("first")
    } else {
      // The fork carries every referenced image even after the source's images are removed.
      rmSync(rewind.directory, { recursive: true })
      expect(existsSync(recorder.directory)).toBe(true)
      recorder.restore(first, null)
      expect(readFileSync(file, "utf8")).toBe("original")
    }
  })
}
