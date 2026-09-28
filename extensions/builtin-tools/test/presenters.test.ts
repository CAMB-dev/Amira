import { afterAll, beforeAll, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type ToolCallView, type ToolResult, textResult, toolResultText } from "@amira/api"
import { editTool } from "../src/edit.ts"
import { globTool } from "../src/glob.ts"
import { grepTool } from "../src/grep.ts"
import {
  editPresenter,
  globPresenter,
  grepPresenter,
  readPresenter,
  shellPresenter,
  writePresenter,
} from "../src/presenters.ts"
import { readTool } from "../src/read.ts"
import { writeTool } from "../src/write.ts"
import { makeCtx, tempDirs } from "./util.ts"

const tmp = tempDirs()
let dir: string
beforeAll(async () => {
  dir = await tmp.make()
  await writeFile(join(dir, "a.ts"), "one\ntwo\nthree\nfour\n")
  await writeFile(join(dir, "b.ts"), "two\n")
})
afterAll(() => tmp.cleanup())

const view = <A>(args: A, result: ToolResult): ToolCallView<A, any> => ({
  args,
  result,
  text: toolResultText(result),
})
const opts = { detail: "summary" as const, width: 80 }

test("read: the path and range as head, the lines read as result", async () => {
  expect(readPresenter.summary!({ path: "a.ts" })).toBe("a.ts")
  expect(readPresenter.summary!({ path: "a.ts", offset: 10, limit: 5 })).toBe("a.ts · lines 10–14")
  const whole = await readTool.execute({ path: "a.ts" }, makeCtx(dir))
  expect(readPresenter.result!(view({ path: "a.ts" }, whole))).toBe("4 lines")
  const part = await readTool.execute({ path: "a.ts", offset: 2, limit: 2 }, makeCtx(dir))
  expect(readPresenter.result!(view({ path: "a.ts" }, part))).toBe("2 lines (2–3 of 4)")
  // Nothing more in summary detail; the content with its line numbers in full.
  expect(readPresenter.body!(view({ path: "a.ts" }, whole), opts)).toEqual([])
  expect(readPresenter.body!(view({ path: "a.ts" }, whole), { ...opts, detail: "full" })[1]).toEqual({
    kind: "code",
    text: "two",
    lineNo: 2,
  })
  // A resumed session has no details: the result is counted from the text.
  expect(readPresenter.result!(view({ path: "a.ts" }, { content: whole.content }))).toBe("4 lines")
})

test("edit: the path as head, +added −removed as result and the diff as body", async () => {
  const args = { path: "a.ts", old_string: "two", new_string: "2" }
  expect(editPresenter.summary!({ ...args, replace_all: true })).toBe("a.ts · all")
  const r = await editTool.execute(args, makeCtx(dir))
  const call = view(args, r)
  expect(editPresenter.result!(call)).toBe("+1 −1")
  expect(editPresenter.body!(call, opts)).toEqual([
    { kind: "diff-context", text: "one", lineNo: 1 },
    { kind: "diff-remove", text: "two", lineNo: 2 },
    { kind: "diff-add", text: "2", lineNo: 2 },
    { kind: "diff-context", text: "three", lineNo: 3 },
    { kind: "diff-context", text: "four", lineNo: 4 },
  ])
  // After a resume the change is worked out from the arguments, without line numbers.
  const resumed = view(args, { content: r.content })
  expect(editPresenter.result!(resumed)).toBe("+1 −1")
  expect(editPresenter.body!(resumed, opts)).toEqual([
    { kind: "diff-remove", text: "two" },
    { kind: "diff-add", text: "2" },
  ])
})

test("write: created files count their lines, overwrites show the change", async () => {
  const created = await writeTool.execute({ path: "n.ts", content: "a\nb\n" }, makeCtx(dir))
  expect(writePresenter.result!(view({ path: "n.ts", content: "" }, created))).toBe("created · 2 lines")
  const over = await writeTool.execute({ path: "n.ts", content: "a\nc\n" }, makeCtx(dir))
  const call = view({ path: "n.ts", content: "a\nc\n" }, over)
  expect(writePresenter.result!(call)).toBe("+1 −1")
  expect(writePresenter.body!(call, opts).map((l) => l.kind)).toEqual([
    "diff-context",
    "diff-remove",
    "diff-add",
  ])
})

test("shell: the command alone as head, exit code and output lines as result, output only on failure", () => {
  expect(shellPresenter.summary!({ command: "bun test\n  --watch", timeout: 5000 })).toBe("bun test …")
  const ok = {
    content: [{ type: "text" as const, text: "a\nb\n\nExit code: 0" }],
    details: { exitCode: 0, timedOut: false, aborted: false, outputLines: 2 },
  }
  expect(shellPresenter.result!(view({ command: "x" }, ok))).toBe("exit 0 · 2 lines")
  expect(shellPresenter.body!(view({ command: "x" }, ok), opts)).toEqual([])
  const failed = {
    content: [{ type: "text" as const, text: "Shell: pwsh\n\nboom\n\nExit code: 1" }],
    isError: true,
    details: { exitCode: 1, timedOut: false, aborted: false, outputLines: 1 },
  }
  expect(shellPresenter.result!(view({ command: "x" }, failed))).toBe("exit 1 · 1 line")
  expect(shellPresenter.body!(view({ command: "x" }, failed), opts)).toEqual([{ kind: "code", text: "boom" }])
  const timedOut = { ...failed, details: { ...failed.details, exitCode: null, timedOut: true } }
  expect(shellPresenter.result!(view({ command: "x" }, timedOut))).toBe("timed out · 1 line")
  // Without details the exit code is read from the text.
  expect(shellPresenter.result!(view({ command: "x" }, textResult("x\n\nExit code: 3", true)))).toBe(
    "exit 3 · 1 line",
  )
})

test("grep and glob: the pattern and where as head, what they found as result", async () => {
  expect(grepPresenter.summary!({ pattern: "TODO", path: "src", glob: "*.ts", ignore_case: true })).toBe(
    "/TODO/i in src · *.ts",
  )
  const content = await grepTool.execute({ pattern: "o", output_mode: "content" }, makeCtx(dir))
  expect(grepPresenter.result!(view({ pattern: "two" }, content))).toBe("3 matches in 2 files")
  const files = await grepTool.execute({ pattern: "o" }, makeCtx(dir))
  expect(grepPresenter.result!(view({ pattern: "two" }, files))).toBe("2 files")
  const none = await grepTool.execute({ pattern: "zzz" }, makeCtx(dir))
  expect(grepPresenter.result!(view({ pattern: "zzz" }, none))).toBe("no matches")
  expect(globPresenter.summary!({ pattern: "**/*.ts", path: "src" })).toBe("**/*.ts in src")
  const glob = await globTool.execute({ pattern: "*.ts" }, makeCtx(dir))
  expect(globPresenter.result!(view({ pattern: "*.ts" }, glob))).toBe("3 files")
})
