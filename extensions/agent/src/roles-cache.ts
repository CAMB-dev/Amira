import type { ExtensionAPI } from "@amira/api"
import { loadRoles, type Role, type RoleDirs } from "./roles.ts"

export interface RolesCacheDeps {
  api: Pick<ExtensionAPI, "reportError">
  dirs: RoleDirs
  reported: Set<string>
}

/** Loads roles at most once every two seconds, reporting each malformed role only once. */
export function roles(deps: RolesCacheDeps): () => Map<string, Role> {
  let cached: { at: number; roles: Map<string, Role> } | undefined

  return () => {
    if (cached && Date.now() - cached.at < 2000) return cached.roles
    const found = loadRoles(deps.dirs)
    for (const p of found.problems) {
      if (deps.reported.has(p)) continue
      deps.reported.add(p)
      deps.api.reportError(`skipped agent role ${p}`)
    }
    cached = { at: Date.now(), roles: found.roles }
    return found.roles
  }
}
