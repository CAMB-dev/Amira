// Runs in a fresh Bun process: the first bash call of a process is the one that used to escape the job.
import "../../../../packages/core/src/index.ts"
import { bashTool } from "../../src/bash.ts"

const [marker, cwd] = process.argv.slice(2)
const r = await bashTool.execute(
  { command: `(sleep ${marker} &); sleep ${marker} & sleep ${marker}`, timeout: 2000 },
  { cwd: cwd!, toolCallId: "fresh", signal: new AbortController().signal, update() {} },
)
console.log(
  JSON.stringify({ text: r.content[0]?.type === "text" ? r.content[0].text : "", details: r.details }),
)
process.exit(0)
