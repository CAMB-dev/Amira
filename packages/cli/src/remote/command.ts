import { directoryServerArtifacts, type ServerArtifactSource, verifyServerBundle } from "./artifacts.ts"
import { RemoteConnection, type RemoteConnectionOptions } from "./connection.ts"
import {
  assertDaemonCompatibility,
  installRemoteServer,
  openRemoteRelay,
  probeRemote,
  validateRemotePath,
} from "./install.ts"
import type { RemoteHello, RemoteRelease, RemoteWelcome } from "./protocol.ts"
import { classifyReconnectFailure, RemoteSetupError, setupDiagnostic } from "./reconnect-failure.ts"
import { launchSsh, type SshLauncher, type SshSession, validateSshHost } from "./ssh.ts"
import {
  type RemoteModelMode,
  type RemoteTargetRecord,
  RemoteTargetStore,
  validateTargetName,
} from "./targets.ts"

export const REMOTE_USAGE = `Usage:
  amira remote add <host> [--name <name>] [--cwd <remote-path>] [--accept-install] [--remote-key] [--bundle <directory>]
  amira remote attach <name-or-host> [--cwd <remote-path>] [--accept-install] [--remote-key] [--bundle <directory>]

Uses system OpenSSH without agent forwarding or a PTY. Setup verifies a signed
server bundle matching this client build. Release artifacts are cached/downloaded locally;
--bundle selects an offline directory. --accept-install grants first-use consent,
including automatic binary updates. Updates never stop running work.
Models run through your local provider connection by default; keys are not copied remotely.
--remote-key opts into provider credentials configured on the remote host.
`

export interface RemoteCommandOptions {
  action: "add" | "attach"
  target: string
  name?: string
  cwd?: string
  bundle?: string
  acceptInstall: boolean
  modelMode?: RemoteModelMode
}
export interface RemoteAttachContext {
  host: string
  workspace: string
  installedRelease: RemoteRelease
  /** Defaults to local-proxy. Remote keys require explicit target consent. */
  modelMode?: RemoteModelMode
  /** Reprobe and verify/reinstall before each fresh relay, including automatic reconnects.
   * Raw users MUST call validateWelcome before operations. */
  open(): Promise<SshSession>
  validateWelcome(welcome: RemoteWelcome): { replacementPending: boolean }
  /** Preferred hook: performs the wire handshake and checks actual daemon compatibility. */
  connect(
    options: Omit<RemoteConnectionOptions, "handshake"> & { hello: RemoteHello },
  ): Promise<RemoteConnection>
}
export interface RemoteCommandDependencies {
  localHome: string
  release: Pick<RemoteRelease, "version" | "buildId">
  publicKey: string
  artifacts?: ServerArtifactSource
  launcher?: SshLauncher
  interactive?: boolean
  consent?(disclosure: string): Promise<boolean>
  write?(text: string): void
  attach?(context: RemoteAttachContext): Promise<number> | Promise<void>
  /** Explicitly reviewed wire/capability compatibility; default is exact build identity only. */
  compatibleDaemon?(welcome: RemoteWelcome, installed: RemoteRelease): boolean
}

export function parseRemoteCommand(argv: readonly string[]): RemoteCommandOptions {
  const [action, target, ...rest] = argv
  if ((action !== "add" && action !== "attach") || !target || target.startsWith("-"))
    throw new Error(REMOTE_USAGE)
  const options: RemoteCommandOptions = { action, target, acceptInstall: false }
  const seen = new Set<string>()
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index]!
    const key = flag === "--yes" ? "--accept-install" : flag
    if (seen.has(key)) throw new Error(`Repeated remote option: ${flag}`)
    seen.add(key)
    if (key === "--accept-install") options.acceptInstall = true
    else if (key === "--remote-key") options.modelMode = "remote-key"
    else if (key === "--name" || key === "--cwd" || key === "--bundle") {
      const value = rest[++index]
      if (!value || value.startsWith("-")) throw new Error(`Provide a value for ${flag}`)
      if (key === "--name") options.name = validateTargetName(value)
      if (key === "--cwd") options.cwd = validateRemotePath(value)
      if (key === "--bundle") options.bundle = value
    } else throw new Error(`Unknown remote option: ${flag}`)
  }
  if (action === "attach" && options.name) throw new Error("--name is only supported by remote add")
  return options
}

function defaultName(host: string): string {
  return validateTargetName(
    host
      .replace(/[^a-zA-Z0-9_.-]/g, "_")
      .replace(/^_+/, "")
      .slice(0, 128),
  )
}

export async function runRemoteCommand(
  argv: readonly string[],
  dependencies: RemoteCommandDependencies,
): Promise<number> {
  const write =
    dependencies.write ??
    ((text: string) => {
      process.stderr.write(`${text}\n`)
    })
  if (argv.length === 0 || (argv.length === 1 && ["help", "--help", "-h"].includes(argv[0]!))) {
    write(REMOTE_USAGE)
    return 0
  }
  const options = parseRemoteCommand(argv)
  if (options.action === "attach" && !dependencies.attach)
    throw new Error("Remote frontend is unavailable in this client")
  const store = new RemoteTargetStore(dependencies.localHome)
  const byName =
    options.action === "attach" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(options.target)
      ? await store.read(options.target)
      : undefined
  const host = validateSshHost(byName?.host ?? options.target)
  const previous = byName ?? (await store.find(host))
  const modelMode = options.modelMode ?? previous?.consent.modelMode ?? "local-proxy"
  const name = options.name ?? previous?.name ?? defaultName(host)
  const named = await store.read(name)
  if (named && named.host !== host) throw new Error("That remote target name belongs to another host")
  const launcher = dependencies.launcher ?? launchSsh
  const probe = await probeRemote(host, launcher)
  const source = options.bundle ? directoryServerArtifacts(options.bundle) : dependencies.artifacts
  if (!source) throw new Error("Supply a signed local server bundle with --bundle <directory>")
  const verified = verifyServerBundle(
    await source.load(probe.target),
    dependencies.publicKey,
    dependencies.release,
    probe.target,
  )
  const modelDisclosure =
    modelMode === "remote-key"
      ? "Provider credentials configured on the remote host are used for model requests. Local provider keys are not copied remotely."
      : "Model requests pass through this client to your local provider connection. Provider keys stay local."
  const disclosure = `Remote target: ${host} (user ${probe.user}, uid ${probe.uid})
Install location: ${probe.installRoot}
Server: ${verified.release.version} (${verified.release.buildId}, ${probe.target})
${modelDisclosure}
Future connections automatically install matching signed server builds here. Running work is never stopped by an update.`
  const approved =
    previous?.home === probe.home &&
    previous.user === probe.user &&
    previous.uid === probe.uid &&
    previous.installRoot === probe.installRoot &&
    previous.consent.modelMode === modelMode
  if (!approved) {
    write(disclosure)
    const accepted =
      options.acceptInstall ||
      (dependencies.interactive === true && (await dependencies.consent?.(disclosure)) === true)
    if (!accepted)
      throw new Error("Remote setup was not approved. Use --accept-install for noninteractive setup")
  }
  let installedRelease = await installRemoteServer({ host, launcher, probe, verified })
  const record: RemoteTargetRecord = {
    schema: 1,
    name,
    host,
    workspace: options.cwd ?? previous?.workspace ?? probe.home,
    home: probe.home,
    user: probe.user,
    uid: probe.uid,
    installRoot: probe.installRoot,
    consent: { automaticUpdates: true, modelMode },
    release: installedRelease,
  }
  await store.save(record)
  if (options.action === "add") {
    write(`Remote target ${name} is ready. Attach with: amira remote attach ${name}`)
    return 0
  }
  const context: RemoteAttachContext = {
    host,
    workspace: record.workspace,
    get installedRelease() {
      return installedRelease
    },
    modelMode,
    async open() {
      const fresh = await probeRemote(host, launcher)
      // Saved installation consent does not authorize a different SSH identity or platform.
      if (
        fresh.home !== record.home ||
        fresh.user !== record.user ||
        fresh.uid !== record.uid ||
        fresh.installRoot !== record.installRoot ||
        fresh.target !== probe.target
      )
        throw new RemoteSetupError(
          "consent_required",
          "Remote identity or platform changed; approve setup again before reconnecting",
          `Automatic reconnect stopped. Detach and run amira remote add ${host} --accept-install, then attach again.`,
        )
      let matching: ReturnType<typeof verifyServerBundle>
      try {
        matching = verifyServerBundle(
          await source.load(fresh.target),
          dependencies.publicKey,
          dependencies.release,
          fresh.target,
        )
      } catch (error) {
        if (classifyReconnectFailure(error).retryable) throw error
        throw new RemoteSetupError(
          "provenance_rejected",
          setupDiagnostic(error, "The signed server artifact could not be verified."),
          "Automatic reconnect stopped. Check the signed server bundle/cache and trusted release key, then use /reconnect.",
        )
      }
      try {
        installedRelease = await installRemoteServer({ host, launcher, probe: fresh, verified: matching })
      } catch (error) {
        if (classifyReconnectFailure(error).retryable) throw error
        throw new RemoteSetupError(
          "installation_failed",
          setupDiagnostic(error, "The remote server installation failed."),
          "Automatic reconnect stopped. Fix remote server installation, then use /reconnect or run amira remote add again.",
        )
      }
      record.release = installedRelease
      await store.save(record)
      return openRemoteRelay(host, fresh, launcher, modelMode)
    },
    validateWelcome: (welcome) =>
      assertDaemonCompatibility(welcome, installedRelease, dependencies.compatibleDaemon, modelMode),
    async connect({ hello, ...connectionOptions }) {
      if (hello.workspace !== record.workspace) throw new Error("Remote workspace selector changed")
      const session = await context.open()
      let replacementPending = false
      const connection = new RemoteConnection(session, {
        ...connectionOptions,
        handshake: {
          role: "client",
          hello,
          validateWelcome(welcome) {
            replacementPending = context.validateWelcome(welcome).replacementPending
          },
        },
      })
      try {
        const welcome = await connection.ready
        if (replacementPending)
          write(
            `Installed server ${installedRelease.version} (${installedRelease.buildId}); running daemon ${welcome.release.version} (${welcome.release.buildId}). Replacement is waiting for idle; running work is unchanged.`,
          )
        return connection
      } catch (error) {
        connection.close()
        await session.exited.catch(() => {})
        throw error
      }
    },
  }
  return (await dependencies.attach!(context)) ?? 0
}
