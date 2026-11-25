import type { CommandCandidate, CommandDefinition, Settings } from "@amira/api"
import { type InstallSource, installSource, upgradeCommand } from "./install-source.ts"
import { createUpdater } from "./update/index.ts"
import {
  fetchVerifiedManifest,
  manifestUrl,
  type ReleaseManifest,
  versionManifestUrl,
} from "./update/manifest.ts"
import { releasePublicKey } from "./update/public-key.ts"
import { parseVersion } from "./update/semver.ts"
import {
  belowMinimum,
  type UpdateChannel,
  type UpdateEngine,
  updateChannel,
  updateSwitch,
} from "./update-command.ts"
import { channel as buildChannel, target as buildTarget, version as buildVersion } from "./version.ts"

export interface TuiUpdateCommandOptions {
  settings: () => Settings
  updater?: () => UpdateEngine
  source?: () => InstallSource
  env?: Record<string, string | undefined>
  version?: string
  target?: string
  publicKey?: string
  fetchManifest?: (url: string, pem: string, signal?: AbortSignal) => Promise<ReleaseManifest>
}

const CANDIDATES: CommandCandidate[] = [
  { value: "check", description: "Check GitHub Releases for a newer Amira version" },
  { value: "install", description: "Download, verify, and install the latest update" },
  { value: "stable", description: "Check or install from the stable channel" },
  { value: "next", description: "Check or install from the next (prerelease/nightly) channel" },
  { value: "version", description: "Install a specific GitHub release version (e.g. 0.0.2)" },
  { value: "rollback", description: "Roll back to the previously installed Amira version" },
]

function parseArgs(
  raw: string,
):
  | { action: "default"; channel?: UpdateChannel }
  | { action: "check"; channel?: UpdateChannel }
  | { action: "install"; channel?: UpdateChannel }
  | { action: "version"; version: string }
  | { action: "rollback" }
  | { action: "invalid"; message: string } {
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  if (!parts.length || parts[0] === "status") return { action: "default" }
  const [first, second, ...rest] = parts
  if (first === "rollback") {
    return parts.length === 1
      ? { action: "rollback" }
      : { action: "invalid", message: "Usage: /update rollback" }
  }
  if (first === "stable" || first === "next") {
    return parts.length === 1
      ? { action: "default", channel: first }
      : { action: "invalid", message: `Usage: /update ${first}` }
  }
  if (first === "check") {
    if (!second) return { action: "check" }
    if ((second === "stable" || second === "next") && !rest.length) {
      return { action: "check", channel: second }
    }
    return { action: "invalid", message: "Usage: /update check [stable|next]" }
  }
  if (first === "install" || first === "now") {
    if (!second) return { action: "install" }
    if ((second === "stable" || second === "next") && !rest.length) {
      return { action: "install", channel: second }
    }
    return { action: "invalid", message: "Usage: /update install [stable|next]" }
  }
  if (first === "version") {
    if (!second || rest.length) return { action: "invalid", message: "Usage: /update version <X.Y.Z>" }
    const normalized = second.replace(/^v/, "")
    if (!parseVersion(normalized)) {
      return { action: "invalid", message: `Invalid version: ${second} (expected semver like 0.0.2)` }
    }
    return { action: "version", version: normalized }
  }
  return {
    action: "invalid",
    message: "Usage: /update [check | install | stable | next | version <X.Y.Z> | rollback]",
  }
}

export function createTuiUpdateCommand(options: TuiUpdateCommandOptions): CommandDefinition {
  return {
    name: "update",
    description: "Check for Amira updates from GitHub Releases, install, or roll back",
    args: {
      hint: "[check | install | stable | next | version <X.Y.Z> | rollback]",
      complete: () => CANDIDATES,
    },
    async run(raw, ctx) {
      ctx.signal.throwIfAborted()
      const parsed = parseArgs(raw)
      if (parsed.action === "invalid") {
        ctx.print(parsed.message, "warning")
        return
      }
      const env = options.env ?? process.env
      if (updateSwitch(env.AMIRA_DISABLE_UPDATES)) {
        ctx.print("Updates are disabled by AMIRA_DISABLE_UPDATES.", "warning")
        return
      }
      const settings = options.settings()
      const currentVersion = options.version ?? buildVersion
      const targetName = options.target ?? buildTarget
      const source = options.source ? options.source() : installSource()
      const defaultChannel = updateChannel(settings.updates?.channel)
      const channel: UpdateChannel = "channel" in parsed && parsed.channel ? parsed.channel : defaultChannel
      const upgrade = upgradeCommand(source)

      if (parsed.action === "rollback") {
        if (upgrade || source === "dev") {
          ctx.print(
            `Managed rollback is unavailable for ${source} installations. Use your package manager or git to switch versions.`,
            "warning",
          )
          return
        }
        const updater = options.updater ? options.updater() : createUpdater()
        try {
          const rolled = await updater.rollback(settings.updates?.minimumVersion)
          ctx.print(`Rolled back to Amira ${rolled}. Restart Amira to use the previous version.`, "info")
        } finally {
          await updater.stop?.().catch(() => {})
        }
        return
      }

      if (updateSwitch(env.AMIRA_OFFLINE)) {
        ctx.print("Update checks and downloads are disabled by AMIRA_OFFLINE.", "warning")
        return
      }

      const pem = options.publicKey ?? releasePublicKey
      const readManifest = (url: string) =>
        options.fetchManifest
          ? options.fetchManifest(url, pem, ctx.signal)
          : fetchVerifiedManifest(url, pem, { signal: ctx.signal })

      // Non-self-managed installs (npm/pnpm/bun/dev) still get verified GitHub release checks + exact upgrade command.
      if (upgrade || source === "dev") {
        const header = `Amira ${currentVersion} (${buildChannel}, ${targetName}, installed via ${source})`
        if (!pem) {
          const how = upgrade
            ? `Upgrade with: ${upgrade}${channel === "next" ? "@next" : ""}`
            : "Update from git."
          ctx.print(`${header}. ${how}`, "info")
          return
        }
        const url = parsed.action === "version" ? versionManifestUrl(parsed.version) : manifestUrl(channel)
        let manifest: ReleaseManifest
        try {
          manifest = await readManifest(url)
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          ctx.print(`${header}\nCould not check GitHub Releases (${channel}): ${msg}`, "warning")
          return
        }
        const cmp = Bun.semver.order(manifest.version, currentVersion)
        const suffix =
          parsed.action === "version" ? `@${manifest.version}` : channel === "next" ? "@next" : ""
        const how = upgrade
          ? `Run: ${upgrade}${suffix}`
          : "This is a local dev/source build. Pull the latest changes with git pull."
        if (parsed.action !== "version" && cmp <= 0) {
          ctx.print(`${header}\nUp to date with GitHub Releases (${channel}: ${manifest.version}).`, "info")
          return
        }
        ctx.print(
          `${header}\nGitHub Release ${manifest.version} (${manifest.channel}) is available. ${how}`,
          "info",
        )
        return
      }

      // Self-managed single-file GitHub Releases installation.
      const updater = options.updater ? options.updater() : createUpdater()
      const onAbort = () => void updater.stop?.().catch(() => {})
      ctx.signal.addEventListener("abort", onAbort, { once: true })
      try {
        const reason = await updater.disabledReason()
        if (reason) {
          ctx.print(reason, "warning")
          return
        }
        if (parsed.action === "version") {
          if (!updater.checkVersion || !updater.updateVersion) {
            ctx.print("Explicit version updates are unavailable in this build.", "warning")
            return
          }
          const target = await updater.checkVersion(parsed.version)
          if (belowMinimum(target.version, settings.updates?.minimumVersion)) {
            ctx.print(
              `Release ${target.version} is below updates.minimumVersion (${settings.updates?.minimumVersion}).`,
              "warning",
            )
            return
          }
          if (target.version === currentVersion) {
            ctx.print(`Amira ${currentVersion} is already installed.`, "info")
            return
          }
          ctx.print(`Downloading and verifying Amira ${target.version} from GitHub Releases…`, "info")
          const installed = await updater.updateVersion(target.version)
          ctx.print(`Updated to Amira ${installed}. Restart Amira to switch to the new version.`, "info")
          return
        }

        const target = await updater.check(channel)
        if (belowMinimum(target.version, settings.updates?.minimumVersion)) {
          ctx.print(
            `Release ${target.version} is below updates.minimumVersion (${settings.updates?.minimumVersion}).`,
            "warning",
          )
          return
        }
        if (Bun.semver.order(target.version, currentVersion) <= 0) {
          ctx.print(`Amira ${currentVersion} is up to date on ${channel}.`, "info")
          return
        }
        if (parsed.action === "check") {
          ctx.print(
            `Amira ${target.version} is available on ${channel} (current: ${currentVersion}). Run /update install ${channel} to update.`,
            "info",
          )
          return
        }
        if (parsed.action === "default") {
          const confirmed = await ctx.ui.confirm(
            `Update Amira ${currentVersion} → ${target.version} (${channel})?`,
            "Downloads the signed release from GitHub and activates on next restart.",
          )
          if (!confirmed) {
            ctx.print(`Update skipped. Run /update install ${channel} whenever you are ready.`, "info")
            return
          }
        }
        ctx.print(
          `Downloading and verifying Amira ${target.version} (${channel}) from GitHub Releases…`,
          "info",
        )
        const installed = await updater.update(channel)
        ctx.print(`Updated to Amira ${installed}. Restart Amira to switch to the new version.`, "info")
      } finally {
        ctx.signal.removeEventListener("abort", onAbort)
        await updater.stop?.().catch(() => {})
      }
    },
  }
}
