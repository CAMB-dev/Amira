import path from "node:path"
import type { ExtensionAdmin, ExtensionOperationOptions, ExtensionScope } from "@amira/api"
import { DEFAULT_PACKAGES_DISABLED } from "@amira/api"
import { amiraHome, loadSettings } from "@amira/core"
import { defaultGitCacheDir, GitCache } from "./git-cache.ts"
import { type IndexOptions, loadIndex, searchIndex } from "./index-file.ts"
import { installPackage, removePackage, updatePackages } from "./install.ts"
import { listInstalled, projectScopeIsUser, type Where } from "./installed.ts"
import { describeSource, packageScope } from "./lock.ts"
import { PackageError } from "./manifest.ts"
import { projectTrust, setPackageDisabled } from "./settings.ts"

/** The same package operations as `amira ext`, without owning a frontend or loading code. */
export function createExtensionAdmin(
  where: Where,
  options: { index?: IndexOptions; fetch?: typeof fetch } = {},
): ExtensionAdmin {
  const home = where.home ?? amiraHome()
  const location = { ...where, home }
  const index = { cacheFile: path.join(home, "cache", "extensions-index.json"), ...options.index }
  const installed = () => listInstalled(location)
  const requireInstalled = (name: string, scope?: ExtensionScope) => {
    if (installed().some((p) => p.name === name && (!scope || p.scope === scope))) return
    const other = installed().find((p) => p.name === name)
    throw new PackageError(
      `${name} is not installed in ${scope ? `the ${scope} scope` : "either scope"}${other ? `; it is in the ${other.scope} scope (use ${other.scope === "project" ? "--project" : "user scope"})` : ""}`,
    )
  }
  const operation = (scope: ExtensionScope, opts: ExtensionOperationOptions) => {
    const cacheDir = defaultGitCacheDir(home)
    return {
      ...opts,
      scope: packageScope(scope, location),
      cwd: where.cwd,
      index: { ...index, signal: opts.signal },
      cacheDir,
      gitCache: new GitCache(cacheDir),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }
  }
  return {
    list() {
      const settings = loadSettings(location).settings
      const disabled = new Set(settings.packages?.disabled ?? [...DEFAULT_PACKAGES_DISABLED])
      const trusted = projectScopeIsUser(location) || projectTrust(where.cwd, settings) === true
      return installed().map((p) => ({
        name: p.name,
        version: p.entry.version,
        scope: p.scope,
        enabled: !disabled.has(p.name),
        trusted: p.scope === "user" || trusted,
        source: describeSource(p.entry.source),
        description: p.manifest?.description ?? "",
        ...(p.error ? { error: p.error } : {}),
        ...(p.shadowed ? { shadowed: true } : {}),
      }))
    },
    async search(query, signal) {
      const loaded = await loadIndex({ ...index, signal })
      return { extensions: searchIndex(loaded.index, query), warnings: loaded.warnings }
    },
    async install(name, scope, opts) {
      // Like the CLI, reinstalling refreshes the package atomically and keeps the old copy on failure.
      const result = await installPackage(name, operation(scope, opts))
      return { name: result.name, version: result.entry.version, warnings: result.warnings }
    },
    async update(names, scope, opts, each) {
      for (const name of names) requireInstalled(name, scope)
      await updatePackages(operation(scope, opts), names, (r) =>
        each(
          "error" in r
            ? { name: r.name, version: r.from.version, changed: false, error: r.error }
            : { name: r.name, version: r.to.version, changed: r.changed },
        ),
      )
    },
    remove(name, scope) {
      requireInstalled(name, scope)
      if (!removePackage(name, packageScope(scope, location)))
        throw new PackageError(`${name} was not removed`)
    },
    setEnabled(name, enabled) {
      requireInstalled(name)
      return setPackageDisabled(name, !enabled, home)
    },
  }
}
