import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ServerArtifactSource, ServerBundle, ServerTarget } from "../../src/remote/artifacts.ts"
import type { RemoteCommandDependencies } from "../../src/remote/command.ts"
import { type SshSession, spawnSshProcess } from "../../src/remote/ssh.ts"

export const deploymentRelease = { version: "0.1.0", buildId: "development-deployment-tests" }
export const deploymentTarget: ServerTarget = "bun-linux-x64-baseline"
const key = generateKeyPairSync("ed25519")
export const deploymentPublicKey = key.publicKey.export({ type: "spki", format: "pem" }).toString()
export const deploymentBinary = Buffer.from("offline signed server fixture\n")

export function signedBundle(
  overrides: Record<string, unknown> = {},
  binary: Uint8Array = deploymentBinary,
): ServerBundle {
  const manifest = Buffer.from(
    JSON.stringify({
      product: "amira-server",
      ...deploymentRelease,
      channel: "stable",
      artifacts: [
        {
          target: deploymentTarget,
          file: `amira-server-${deploymentTarget}`,
          size: binary.length,
          sha256: createHash("sha256").update(binary).digest("hex"),
        },
      ],
      ...overrides,
    }),
  )
  return { manifest, signature: sign(null, manifest, key.privateKey).toString("base64"), binary }
}

export interface DeploymentFixture {
  root: string
  local: string
  remote: string
  config: Record<string, unknown>
  calls: string[][]
  children: SshSession[]
  dependencies: RemoteCommandDependencies
  configure(values: Record<string, unknown>): Promise<void>
  state(): Promise<Record<string, unknown> | undefined>
  dispose(): Promise<void>
}

export async function deploymentFixture(): Promise<DeploymentFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "amira-deployment-"))
  const local = path.join(root, "local")
  const remote = path.join(root, "remote")
  const workspace = path.join(root, "workspace")
  await Promise.all([local, remote, workspace].map((directory) => mkdir(directory)))
  const configuration = path.join(root, "config.json")
  const config: Record<string, unknown> = {
    home: "/home/remote ' user",
    os: "Linux",
    arch: "x86_64",
    libc: "glibc 2.31",
    cpu: "baseline",
    ...deploymentRelease,
    target: deploymentTarget,
  }
  const children: SshSession[] = []
  const calls: string[][] = []
  const source: ServerArtifactSource = { load: async () => signedBundle() }
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of Object.keys(env))
    if (/^AMIRA_LIVE_|(?:API_KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD)/i.test(name)) delete env[name]
  Object.assign(env, {
    AMIRA_HOME: local,
    HOME: remote,
    USERPROFILE: remote,
    XDG_CONFIG_HOME: path.join(remote, "config"),
    XDG_CACHE_HOME: path.join(remote, "cache"),
    XDG_DATA_HOME: path.join(remote, "data"),
    XDG_RUNTIME_DIR: path.join(remote, "run"),
    AMIRA_DEPLOYMENT_CONFIG: configuration,
    AMIRA_DEPLOYMENT_REMOTE: remote,
  })
  const fixture: DeploymentFixture = {
    root,
    local,
    remote,
    config,
    children,
    calls,
    dependencies: {
      localHome: local,
      release: deploymentRelease,
      publicKey: deploymentPublicKey,
      artifacts: source,
      write() {},
      launcher(argv) {
        calls.push([...argv])
        const child = spawnSshProcess(
          process.execPath,
          [path.join(import.meta.dir, "deployment-ssh-fixture.ts"), ...argv],
          env,
        )
        children.push(child)
        return child
      },
    },
    async configure(values) {
      Object.assign(config, values)
      await writeFile(configuration, JSON.stringify(config))
    },
    async state() {
      try {
        return JSON.parse(await readFile(path.join(remote, "installed.json"), "utf8"))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      }
    },
    async dispose() {
      for (const child of children) child.close()
      await Promise.all(children.map((child) => child.exited.catch(() => {})))
      await rm(root, { recursive: true, force: true })
    },
  }
  await fixture.configure({})
  return fixture
}

/** Independent restricted POSIX word parser for the exact quoting grammar used by OpenSSH. */
export function shellWords(command: string): string[] {
  const words: string[] = []
  let current = ""
  let quoted = false
  let started = false
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!
    if (character === "'") {
      quoted = !quoted
      started = true
    } else if (!quoted && character === "\\") {
      current += command[++index] ?? ""
      started = true
    } else if (!quoted && character === " ") {
      if (started) words.push(current)
      current = ""
      started = false
    } else {
      current += character
      started = true
    }
  }
  if (quoted) throw new Error("Unterminated shell quote")
  if (started) words.push(current)
  return words
}
