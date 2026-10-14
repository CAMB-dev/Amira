import { spyOn } from "bun:test"
import * as fs from "node:fs"
import path from "node:path"
import "./file-lock-worker-preload.ts"

const [, dir] = process.argv.slice(2)
if (!dir) throw new Error("missing result worker directory")
const write = fs.writeFileSync
const result = path.join(dir, `result-${process.pid}`)
spyOn(fs, "writeFileSync").mockImplementation((...args) => {
  if (typeof args[0] === "number" || !String(args[0]).startsWith(result)) return write(...args)
  // Pause after creation, before the JSON bytes: the reader polls path existence.
  const fd = fs.openSync(args[0], "wx")
  try {
    write(path.join(dir, "paused-result"), "ready")
    const deadline = Date.now() + 5000
    const pause = new Int32Array(new SharedArrayBuffer(4))
    while (!fs.existsSync(path.join(dir, "continue-result"))) {
      if (Date.now() > deadline) throw new Error("result writer timed out")
      Atomics.wait(pause, 0, 0, 10)
    }
    return write(fd, args[1], args[2])
  } finally {
    fs.closeSync(fd)
  }
})
