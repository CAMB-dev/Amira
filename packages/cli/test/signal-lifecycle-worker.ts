import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { EventEmitter } from "node:events"
import { appendFileSync, closeSync, openSync } from "node:fs"
import { copyFile, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { PassThrough } from "node:stream"
import type { Agent } from "@amira/core"
import { modes, ProcessTerminal } from "@amira/tui-kit"
import { runPrint } from "../src/print.ts"
import { createSignalLifecycle } from "../src/signal-lifecycle.ts"
import { swapExecutable } from "../src/update/files.ts"
import { createUpdater } from "../src/update/index.ts"
import { startBackgroundUpdate } from "../src/update-background.ts"

const root = process.argv[2]!
const signal = process.argv[3]! as NodeJS.Signals
const printing = process.argv[4] === "print"
const eventsFile = path.join(root, "events")
const event = (name: string) => appendFileSync(eventsFile, `${name}\n`)
const bin = path.join(root, "bin", "amira.exe")
await mkdir(path.dirname(bin))
await mkdir(path.join(root, "versions", "1.2.3"), { recursive: true })
await writeFile(bin, "1.2.3")
await writeFile(path.join(root, "versions", "1.2.3", "amira.exe"), "1.2.3")
const target = "bun-windows-x64-baseline"
await writeFile(
  path.join(root, "install.json"),
  JSON.stringify({ kind: "single-file", version: "1.2.3", channel: "stable", target, bin }),
)
const bytes = Buffer.from("fixture archive")
const manifest = JSON.stringify({
  version: "1.2.4",
  channel: "stable",
  artifacts: [
    {
      target,
      file: `amira-${target}.zip`,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  ],
})
const keys = generateKeyPairSync("ed25519")
const entered = Promise.withResolvers<void>()
const release = Promise.withResolvers<void>()
const updater = createUpdater({
  version: "1.2.3",
  target,
  installRoot: root,
  bin,
  executable: bin,
  platform: "win32",
  env: {},
  publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  fetch: Object.assign(
    async (url: Parameters<typeof fetch>[0]) =>
      new Response(
        String(url).endsWith("manifest.json.sig")
          ? sign(null, Buffer.from(manifest), keys.privateKey).toString("base64")
          : String(url).endsWith("manifest.json")
            ? manifest
            : bytes,
      ),
    { preconnect() {} },
  ),
  extract: async (_archive, directory, name) => {
    await writeFile(path.join(directory, name), "1.2.4")
  },
  probe: async (file) => readFile(file, "utf8"),
  swap: (source, destination, platform) =>
    swapExecutable(source, destination, platform, {
      rename,
      rm,
      symlink,
      copyFile: async (from, to) => {
        event("copy.wait")
        entered.resolve()
        await release.promise
        await copyFile(from, to)
        event("copy.done")
      },
    }),
})
const terminalFile = path.join(root, "terminal")
const fd = openSync(terminalFile, "a")
const stdout = Object.assign(new EventEmitter(), {
  fd,
  columns: 80,
  rows: 24,
  write(data: string) {
    appendFileSync(terminalFile, data)
    return true
  },
}) as unknown as NodeJS.WriteStream
const terminal = new ProcessTerminal(new PassThrough() as unknown as NodeJS.ReadStream, stdout)
let stopUpdates = async () => {}
const lifecycle = createSignalLifecycle({
  stopUpdates: () => stopUpdates(),
  restoreTerminal: () => {
    event("terminal.restore")
    terminal.emergencyStop()
    closeSync(fd)
  },
})
terminal.start()
terminal.setRawMode(true)
terminal.enableMode(modes.bracketedPaste)
terminal.enterAltScreen()
terminal.onEmergencyExit(() => {
  event(terminal.isRaw ? "terminal.still.raw" : "terminal.transcript")
  return "FULLSCREEN_EMERGENCY_TRANSCRIPT\r\n"
})
process.on("exit", () => {
  event("exit")
})
await startBackgroundUpdate(
  {},
  {
    updater,
    env: {},
    version: "1.2.3",
    stateFile: path.join(root, "update.json"),
    onStop: (stop) => {
      stopUpdates = async () => {
        event("stop.start")
        const stopping = stop()
        setTimeout(() => release.resolve(), 25)
        await stopping
        event("stop.done")
      }
    },
  },
)
await entered.promise
if (printing) {
  const turn = Promise.withResolvers<never>()
  const agent = {
    setNonInteractive() {},
    tools: { setPolicy() {} },
    bus: { subscribe: () => () => {}, flush: async () => {} },
    prompt: () => turn.promise,
    abort: () => event("print.abort"),
  } as unknown as Agent
  void lifecycle.delegateSigint(() =>
    runPrint(agent, "fixture", false, {
      io: { stdout() {}, stderr() {} },
      forceExit: () => {
        void lifecycle.exit(130)
      },
    }),
  )
  process.emit("SIGINT", "SIGINT")
  event("print.first.returned")
}
process.emit(signal, signal)
// A missing application handler lets ProcessTerminal exit synchronously instead of reaching this.
event("signal.returned")
setTimeout(() => {
  throw new Error("Signal shutdown did not finish")
}, 10_000)
