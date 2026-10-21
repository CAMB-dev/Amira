// Offline fake SSH: local child only. Models the Linux transaction, but does not claim Linux execution.
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import { RemoteConnection } from "../../src/remote/connection.ts"
import {
  ATTACH_REMOTE_KEY_SCRIPT,
  ATTACH_SCRIPT,
  INSTALL_SCRIPT,
  PROBE_SCRIPT,
} from "../../src/remote/deployment-scripts.ts"
import { REMOTE_PEER_LIMITS } from "../../src/remote/protocol.ts"
import { workspaceAttachments } from "../../src/server/attachments.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"
import { shellWords } from "./deployment-fixture.ts"

const deny = () => {
  throw new Error("Network access forbidden in deployment fixture")
}
globalThis.fetch = Object.assign(deny, { preconnect: deny })
Bun.connect = deny
Bun.listen = deny
const config = JSON.parse(await readFile(process.env.AMIRA_DEPLOYMENT_CONFIG!, "utf8"))
const root = process.env.AMIRA_DEPLOYMENT_REMOTE!
const stateFile = path.join(root, "installed.json")
const argv = process.argv.slice(2)
if (argv.slice(0, 6).join("|") !== "-T|-a|-o|ForwardAgent=no|--|fixture-host")
  throw new Error("Unsafe or unexpected SSH argv")
if (argv.length !== 7) throw new Error("Remote command must be one quoted argv operand")
const words = shellWords(argv[6]!)
if (words[0] !== "sh" || words[1] !== "-c" || words[3] !== "amira-remote")
  throw new Error("Expected a fixed quoted shell program")
const script = words[2]
const args = words.slice(4)
const state = async () => {
  try {
    return JSON.parse(await readFile(stateFile, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}
const identity = (release: Record<string, unknown>) => ({
  product: "amira-server",
  channel: "stable",
  ...release,
})
try {
  if (script === PROBE_SCRIPT) {
    if (config.probeFailure) {
      process.stderr.write(String(config.probeFailure))
      process.exit(Number(config.probeExitCode ?? 255))
    }
    if (config.probeHang) await new Promise((resolve) => setTimeout(resolve, 60_000))
    if (config.probeFlood) process.stdout.write("x".repeat(128 * 1024))
    const installed = await state()
    process.stdout.write(
      [
        config.os,
        config.arch,
        config.home,
        "remote-user",
        "1000",
        config.libc,
        config.cpu,
        installed ? JSON.stringify(identity(installed)) : "",
        installed && (await Bun.file(path.join(root, "installed.sha256")).exists())
          ? await readFile(path.join(root, "installed.sha256"), "utf8")
          : "",
        "",
      ].join("\0"),
    )
  } else if (script === INSTALL_SCRIPT) {
    if (args.length !== 6 || args[0] !== `${config.home}/.amira/remote`)
      throw new Error("Install operands changed")
    const lock = path.join(root, "install-lock")
    await mkdir(lock)
    const temporary = path.join(root, "upload.tmp")
    try {
      const binary = await Bun.stdin.bytes()
      await writeFile(temporary, binary, { flag: "wx", mode: 0o600 })
      if (config.failure === "interrupted") throw new Error("Interrupted upload")
      if (config.failure === "disk-full") throw new Error("No space left on device")
      if (String(binary.length) !== args[4]) throw new Error("Uploaded executable length mismatch")
      if (config.failure === "checksum" || createHash("sha256").update(binary).digest("hex") !== args[3])
        throw new Error("Uploaded executable SHA-256 mismatch")
      const expected = JSON.parse(args[5]!)
      if (
        config.failure === "identity" ||
        expected.buildId !== config.buildId ||
        expected.version !== config.version
      )
        throw new Error("Uploaded executable build identity mismatch")
      if (config.failure === "self-check") throw new Error("Uploaded executable self-check failed")
      if (config.failure === "publish") throw new Error("Atomic launcher rename failed")
      const release = { version: expected.version, buildId: expected.buildId, target: expected.target }
      const version = path.join(root, `${args[1]}-${release.target}`)
      // Model the production install's immutable destination and collision check.
      const existing = await Bun.file(version).exists()
      if (existing && !Buffer.from(await readFile(version)).equals(Buffer.from(binary)))
        throw new Error("Existing build differs from signed artifact")
      if (!existing) await writeFile(version, binary)
      await writeFile(temporary, JSON.stringify(release))
      await rename(temporary, stateFile)
      await writeFile(path.join(root, "installed.sha256"), args[3]!)
      process.stdout.write(`${args[5]}\n`)
    } finally {
      await rm(temporary, { force: true })
      await rm(lock, { recursive: true })
    }
  } else if (script === ATTACH_SCRIPT || script === ATTACH_REMOTE_KEY_SCRIPT) {
    if (args.length !== 1 || args[0] !== `${config.home}/.amira/remote/bin/amira-server`)
      throw new Error("Attach path was not quoted")
    if (config.relayFailure) {
      if (config.stderrFlood) process.stderr.write(`\x1b]2;untrusted-title\x07${"x".repeat(64 * 1024)}`)
      process.stderr.write(`\x1b[31m${config.relayFailure}\x1b[0m\n`)
      process.exit(Number(config.relayExitCode ?? 1))
    }
    if (config.relayReject) {
      process.stderr.write("Remote account policy also refused attach\n")
      await new Promise<void>(() =>
        process.stdout.end(
          `${JSON.stringify({ v: 1, kind: "reject", error: { code: "permission_denied", message: "Remote protocol policy denies attach" } })}\n`,
          () => process.exit(1),
        ),
      )
    }
    const installed = await state()
    if (!installed) throw new Error("Server is not installed")
    const release = config.runningRelease ?? installed
    let outputClosed = false
    const io = {
      input: process.stdin,
      write: (bytes: Uint8Array) =>
        new Promise<void>((resolve, reject) => {
          if (outputClosed) {
            resolve()
            return
          }
          if (
            (config.relayFailureAfterWelcome || config.relayMalformedFrame) &&
            JSON.parse(new TextDecoder().decode(bytes)).kind === "welcome"
          ) {
            outputClosed = true
            process.stdout.write(bytes, (error) => {
              if (error) {
                reject(error)
                return
              }
              process.stderr.write(
                `\x1b[31m${config.relayFailureAfterWelcome ?? "Remote account policy also refused attach"}\x1b[0m\n`,
              )
              process.exitCode = Number(config.relayExitCode ?? 1)
              process.stdout.end(config.relayMalformedFrame ? "{broken-json}\n" : "", () => {
                process.stdin.destroy()
                resolve()
              })
            })
            return
          }
          if (config.truncateWelcome && JSON.parse(new TextDecoder().decode(bytes)).kind === "welcome") {
            outputClosed = true
            process.stdout.end(bytes.subarray(0, 17), () => {
              process.stdin.destroy()
              resolve()
            })
            return
          }
          process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()))
        }),
      close: () => process.stdin.destroy(),
    }
    const runtime = config.frontend
      ? await createWorkspaceRuntime({
          cwd: root,
          ai: createAi({
            dialects: [createMockDialect([{ text: "reconnect mock answer" }])],
            providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
            env: {},
          }),
          model: "mock/test",
          autoTitle: false,
          builtins: async () => [],
        })
      : undefined
    const server = runtime
      ? workspaceAttachments(runtime, { heartbeatMs: 0 }).connect(io, { release, workspace: config.home })
      : new RemoteConnection(io, {
          handshake: {
            role: "server",
            accept: (hello) => ({
              v: 1,
              kind: "welcome",
              release,
              workspace: hello.workspace,
              workspaceId: "fixture-workspace",
              daemonEpoch: "fixture-epoch",
              sessionGeneration: 1,
              controllerGeneration: 1,
              controllerToken: "fixture-token",
              limits: REMOTE_PEER_LIMITS,
              capabilities: config.capabilities ?? [
                script === ATTACH_REMOTE_KEY_SCRIPT ? "model.remote-key" : "model.proxy",
                "replay",
                "controller",
              ],
            }),
          },
          handle: async () => ({ connected: true }),
        })
    try {
      await server.closed
    } finally {
      await runtime?.stop()
    }
  } else throw new Error("Unexpected remote script")
} catch (error) {
  if (config.stderrFlood) process.stderr.write("x".repeat(64 * 1024))
  process.stderr.write(`\u001b[31m${error instanceof Error ? error.message : "fixture failure"}\u001b[0m\n`)
  process.exitCode = 1
}
