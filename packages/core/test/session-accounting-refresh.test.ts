import { expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { emptyUsage, userMessage } from "@amira/ai"
import { reportedUsage } from "../src/accounting-receipts.ts"
import { conversationUsage } from "../src/owned-conversations-usage.ts"
import { SessionStore } from "../src/session-store.ts"

const blank = " ".repeat(32)
const malformed = "{broken accounting receipt".padEnd(blank.length)

function fixture() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "amira-accounting-refresh-"))
  const store = SessionStore.create({ cwd: dir, dir })
  store.append({
    type: "side_usage",
    model: { provider: "mock", model: "test" },
    usage: reportedUsage({ ...emptyUsage(), input: 20, output: 2, cost: 0.2 }),
  })
  const raw = fs.readFileSync(store.file, "utf8")
  // Keep the editable blank line outside the bounded tail proof.
  const clean = `${raw.replace("\n", `\n${blank}\n`)}${" ".repeat(8192)}\n`
  fs.writeFileSync(store.file, clean)
  return { dir, file: store.file, clean }
}

for (const mode of ["changed", "unchanged", "same generation and tail"] as const) {
  test(`claim refresh retains detected accounting corruption (${mode})`, () => {
    const { dir, file, clean } = fixture()
    const view = SessionStore.open(file)
    const entry = view.entries[0]
    const known = fs.statSync(file, { bigint: true })
    const corrupt =
      mode === "changed" ? `${clean}${malformed}\n` : clean.replace(`\n${blank}\n`, `\n${malformed}\n`)
    let restoreStat: (() => void) | undefined
    try {
      expect(conversationUsage(view).own).toMatchObject({ knownCostUsd: 0.2, complete: true })
      if (mode === "changed") fs.appendFileSync(file, `${malformed}\n`)
      else fs.writeFileSync(file, corrupt)
      if (mode === "same generation and tail") {
        expect(Buffer.byteLength(corrupt)).toBe(Buffer.byteLength(clean))
        expect(Buffer.from(corrupt).subarray(-4096)).toEqual(Buffer.from(clean).subarray(-4096))
        const stat = fs.statSync
        const hook = spyOn(fs, "statSync").mockImplementation(
          new Proxy(stat, {
            apply(target, receiver, args) {
              const current = Reflect.apply(target, receiver, args)
              return args[0] === file && typeof current?.size === "bigint" ? known : current
            },
          }),
        )
        restoreStat = () => hook.mockRestore()
      }
      const fresh = SessionStore.open(file)
      expect(conversationUsage(fresh).own).toMatchObject({ knownCostUsd: 0.2, complete: false })
      expect(view.claim()).toBe(true)
      expect(view.entries).toEqual(fresh.entries)
      if (mode === "changed") expect(view.entries[0]).not.toBe(entry)
      else expect(view.entries[0]).toBe(entry)
      expect(conversationUsage(view).own).toMatchObject({ knownCostUsd: 0.2, complete: false })
      expect(view.accountingDurable).toBe(false)
    } finally {
      restoreStat?.()
      view.release()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("metadata refresh retains corruption when parsed entries and file size are unchanged", () => {
  const { dir, file, clean } = fixture()
  const view = SessionStore.open(file)
  try {
    fs.writeFileSync(file, clean.replace(`\n${blank}\n`, `\n${malformed}\n`))
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(file, future, future)
    view.append({ type: "display", text: "metadata after corruption", level: "info" })
    expect(conversationUsage(view).own).toMatchObject({ knownCostUsd: 0.2, complete: false })
    expect(conversationUsage(SessionStore.open(file)).own.complete).toBe(false)
  } finally {
    view.release()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

for (const changed of [false, true]) {
  test(`clean claim refresh cannot clear prior accounting damage (${changed ? "changed" : "unchanged"})`, () => {
    const { dir, file, clean } = fixture()
    fs.writeFileSync(file, clean.replace(`\n${blank}\n`, `\n${malformed}\n`))
    const view = SessionStore.open(file)
    const entry = view.entries[0]
    try {
      expect(conversationUsage(view).own.complete).toBe(false)
      fs.writeFileSync(file, clean)
      if (changed) SessionStore.open(file).appendMessage(userMessage("new history"))
      expect(conversationUsage(SessionStore.open(file)).own).toMatchObject({
        knownCostUsd: 0.2,
        complete: true,
      })
      expect(view.claim()).toBe(true)
      if (changed) expect(view.entries[0]).not.toBe(entry)
      else expect(view.entries[0]).toBe(entry)
      expect(conversationUsage(view).own).toMatchObject({ knownCostUsd: 0.2, complete: false })
      expect(view.accountingDurable).toBe(false)
    } finally {
      view.release()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}
