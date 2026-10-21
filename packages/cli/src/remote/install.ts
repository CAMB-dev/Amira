import type { ServerTarget, VerifiedServerArtifact } from "./artifacts.ts"
import {
  ATTACH_REMOTE_KEY_SCRIPT,
  ATTACH_SCRIPT,
  INSTALL_SCRIPT,
  PROBE_SCRIPT,
} from "./deployment-scripts.ts"
import type { RemoteRelease, RemoteWelcome } from "./protocol.ts"
import { RemoteSetupError, setupDiagnostic } from "./reconnect-failure.ts"
import { observeSshRelay } from "./relay-io.ts"
import { serverVersionIdentity } from "./release-identity.ts"
import { hasRemoteControlCharacters, runSsh, type SshLauncher, type SshSession, sshArgv } from "./ssh.ts"
import type { RemoteModelMode } from "./targets.ts"

export interface RemoteProbe {
  os: "Linux"
  arch: string
  home: string
  user: string
  uid: number
  libc: string
  cpu: string
  target: ServerTarget
  installRoot: string
  installed?: RemoteRelease
  /** Observed launcher bytes; compare with an authenticated artifact before reuse. */
  installedHash?: string
}

export function validateRemotePath(value: string): string {
  if (!value.startsWith("/") || value.length > 4096 || hasRemoteControlCharacters(value))
    throw new Error("Use an absolute Linux path without control characters for the remote workspace")
  return value
}

export function parseServerIdentity(value: unknown): RemoteRelease {
  if (!value || typeof value !== "object") throw new Error("Invalid installed server identity")
  const release = value as Record<string, unknown>
  if (
    release.product !== "amira-server" ||
    typeof release.version !== "string" ||
    typeof release.buildId !== "string" ||
    typeof release.target !== "string" ||
    release.version.length > 128 ||
    release.buildId.length > 128 ||
    hasRemoteControlCharacters(release.version + release.buildId + release.target)
  )
    throw new Error("Invalid installed server identity")
  return { version: release.version, buildId: release.buildId, target: release.target }
}

/** Conservative supported distro floor: glibc >= 2.28, x64 SSE4.2 or Linux ARM64. */
export function parseRemoteProbe(bytes: Uint8Array): RemoteProbe {
  const fields = Buffer.from(bytes).toString("utf8").split("\0")
  if (fields.length !== 10 || fields.pop() !== "") throw new Error("Invalid remote probe response")
  const [os, arch, home, user, uid, libc, cpu, identity, installedHash] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ]
  if (installedHash && !/^[a-f0-9]{64}$/.test(installedHash)) throw new Error("Invalid installed server hash")
  if (os !== "Linux") throw new Error("Remote workspaces currently require Linux")
  let target: ServerTarget
  if (arch === "x86_64" && cpu === "baseline") target = "bun-linux-x64-baseline"
  else if ((arch === "aarch64" || arch === "arm64") && cpu === "arm64") target = "bun-linux-arm64"
  else throw new Error("Unsupported remote architecture or CPU; x64 requires SSE4.2")
  const glibc = /^glibc (\d+)\.(\d+)$/.exec(libc)
  if (!glibc || Number(glibc[1]) < 2 || (Number(glibc[1]) === 2 && Number(glibc[2]) < 28))
    throw new Error("Remote server bundles require glibc 2.28 or newer; musl is not supported")
  validateRemotePath(home)
  if (!user || hasRemoteControlCharacters(user) || !/^\d+$/.test(uid) || !Number.isSafeInteger(Number(uid)))
    throw new Error("Invalid remote user identity")
  const installRoot = `${home === "/" ? "" : home}/.amira/remote`
  return {
    os,
    arch,
    home,
    user,
    uid: Number(uid),
    libc,
    cpu,
    target,
    installRoot,
    ...(identity ? { installed: parseServerIdentity(JSON.parse(identity)) } : {}),
    ...(installedHash ? { installedHash } : {}),
  }
}

export async function probeRemote(host: string, launcher: SshLauncher): Promise<RemoteProbe> {
  const bytes = await runSsh(launcher, sshArgv(host, PROBE_SCRIPT))
  try {
    return parseRemoteProbe(bytes)
  } catch (error) {
    throw new RemoteSetupError(
      "platform_rejected",
      setupDiagnostic(error, "The remote platform probe was rejected."),
      "Automatic reconnect stopped. Check the Linux platform and SSH target, then run amira remote add again.",
    )
  }
}

export function sameRelease(left: RemoteRelease | undefined, right: RemoteRelease): boolean {
  return left?.buildId === right.buildId && left.version === right.version && left.target === right.target
}

export async function installRemoteServer(options: {
  host: string
  launcher: SshLauncher
  probe: RemoteProbe
  verified: VerifiedServerArtifact
}): Promise<RemoteRelease> {
  const { host, launcher, probe, verified } = options
  if (probe.target !== verified.artifact.target) throw new Error("Remote artifact target mismatch")
  if (sameRelease(probe.installed, verified.release) && probe.installedHash === verified.artifact.sha256)
    return verified.release
  const expectedIdentity = JSON.stringify(serverVersionIdentity(verified.release))
  const output = await runSsh(
    launcher,
    sshArgv(host, INSTALL_SCRIPT, [
      probe.installRoot,
      verified.artifact.sha256,
      verified.artifact.target,
      verified.artifact.sha256,
      String(verified.artifact.size),
      expectedIdentity,
    ]),
    verified.binary,
  )
  if (Buffer.from(output).toString("utf8") !== `${expectedIdentity}\n`)
    throw new Error("Remote installation did not acknowledge the expected build")
  return verified.release
}

export function openRemoteRelay(
  host: string,
  probe: RemoteProbe,
  launcher: SshLauncher,
  modelMode: RemoteModelMode = "local-proxy",
): SshSession {
  const script = modelMode === "remote-key" ? ATTACH_REMOTE_KEY_SCRIPT : ATTACH_SCRIPT
  return observeSshRelay(launcher(sshArgv(host, script, [`${probe.installRoot}/bin/amira-server`])))
}

/** Reviewed v1 capability set; older/incompatible runtimes must retire, never be killed implicitly. */
export function compatibleRemoteDaemon(welcome: RemoteWelcome, installed: RemoteRelease): boolean {
  return (
    welcome.v === 1 &&
    welcome.release.target === installed.target &&
    [
      "frontend.v1",
      "replay",
      "controller",
      "mutation.ledger",
      "files",
      "images",
      "jobs",
      "conversations",
    ].every((capability) => welcome.capabilities.includes(capability))
  )
}

/** No automatic stop/restart. Transitional builds need an explicit compatibility decision. */
export function assertDaemonCompatibility(
  welcome: RemoteWelcome,
  installed: RemoteRelease,
  compatible?: (welcome: RemoteWelcome, installed: RemoteRelease) => boolean,
  modelMode: RemoteModelMode = "local-proxy",
): { replacementPending: boolean } {
  const replacementPending = !sameRelease(welcome.release, installed)
  if (replacementPending && !compatible?.(welcome, installed))
    throw new RemoteSetupError(
      "incompatible_daemon",
      `Server ${installed.version} (${installed.buildId}) is installed, but daemon ${welcome.release.version} (${welcome.release.buildId}) is still running. Wait for it to become idle, or explicitly stop it on the remote host. No running work was stopped.`,
      "Automatic reconnect stopped. Wait for a compatible daemon or explicitly stop it, then use /reconnect.",
    )
  const capability = modelMode === "remote-key" ? "model.remote-key" : "model.proxy"
  if (!welcome.capabilities.includes(capability))
    throw new RemoteSetupError(
      "incompatible_daemon",
      modelMode === "remote-key"
        ? "The running daemon does not support remote model keys. No running work was stopped."
        : "The running daemon does not support local model proxying",
      "Automatic reconnect stopped. Check the selected model mode and remote daemon, then use /reconnect.",
    )
  return { replacementPending }
}
