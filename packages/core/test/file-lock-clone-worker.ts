import * as fs from "node:fs"
import path from "node:path"
import { waitForFileLockCondition } from "./file-lock-test-waits.ts"

const [file, dir, domainJson, absentPid, mode] = process.argv.slice(2)
if (!file || !dir || !domainJson) throw new Error("missing identity worker arguments")
const injected = JSON.parse(domainJson)
let probes = 0
const kill = process.kill
process.kill = (pid, signal) => {
  if (pid === Number(absentPid) && signal === 0) {
    probes++
    throw Object.assign(new Error("PID is absent on this clone"), { code: "ESRCH" })
  }
  return kill(pid, signal)
}

// Real processes exercise the actual gate and lease protocol with isolated host/PID domains.
Bun.plugin({
  name: "lease-test-domain",
  setup(build) {
    build.onLoad({ filter: /file-lock-owner\.ts$/ }, (args) => {
      const source = fs.readFileSync(args.path, "utf8")
      const declaration = "const domain = localDomain()"
      if (!source.includes(declaration)) throw new Error("lease domain injection seam changed")
      return {
        contents: source.replace(
          declaration,
          `const domain = { ...localDomain(), ...${JSON.stringify(injected)} }`,
        ),
        loader: "ts",
      }
    })
  },
})
const { tryFileLock } = await import("../src/file-lock.ts")
const { leaseOwner } = await import("../src/file-lock-owner.ts")
const held = tryFileLock(file, 60_000, undefined, true)
const owner = leaseOwner()
if (owner.host !== injected.host || owner.boot !== injected.boot) throw new Error("domain injection failed")
fs.writeFileSync(
  path.join(dir, "result"),
  JSON.stringify({ state: held ? "acquired" : "blocked", owner, probes }),
)
if (mode === "crash") process.exit(0)
try {
  await waitForFileLockCondition("identity worker stop request", () => fs.existsSync(path.join(dir, "stop")))
} finally {
  held?.release()
}
