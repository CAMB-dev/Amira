// A process tree for the job tests: this process starts a child, which starts a grandchild;
// all three write their pid to the file given as the first argument and then keep running.
// With "--term-log <file>", each writes "term <pid>" there when it gets SIGTERM, then exits.
import { appendFileSync } from "node:fs"

const [file, level = "0", ...rest] = process.argv.slice(2)
const termLog = rest[0] === "--term-log" ? rest[1] : undefined
appendFileSync(file!, `${process.pid}\n`)
if (termLog) {
  process.on("SIGTERM", () => {
    appendFileSync(termLog, `term ${process.pid}\n`)
    process.exit(0)
  })
}
if (Number(level) < 2) {
  Bun.spawn([process.execPath, import.meta.path, file!, String(Number(level) + 1), ...rest], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  })
}
console.log(`level ${level} up`)
setInterval(() => {}, 1 << 30)
