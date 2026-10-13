import { spyOn } from "bun:test"
import * as fs from "node:fs"
import path from "node:path"
import { SessionStore } from "../src/session-store.ts"

const [file, dir] = process.argv.slice(2)
if (!file || !dir) throw new Error("missing transient append worker arguments")
const append = fs.appendFileSync
spyOn(fs, "appendFileSync").mockImplementation((...args) => {
  if (args[0] === file) {
    append(file, '{"type":"display","id":"e_torn"')
    fs.writeFileSync(path.join(dir, "paused"), "ready")
    const pause = new Int32Array(new SharedArrayBuffer(4))
    const deadline = performance.now() + 10_000
    while (performance.now() < deadline) Atomics.wait(pause, 0, 0, 10)
    throw new Error("transient append worker was not killed")
  }
  return append(...args)
})
SessionStore.open(file).appendDisplay({ type: "display", text: "interrupted", level: "info" })
