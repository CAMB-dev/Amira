import type { PermissionMode, PermissionSettings } from "@amira/api"
import { type PermissionRule, stricterMode } from "./policy.ts"

/** One settings layer's permissions, lowest precedence first (see loadSettings). */
export interface PermissionLayer {
  /** The user file, a project file (settings.json or settings.local.json), or the command line. */
  scope: "user" | "project" | "flags"
  /** The file, or the flag. */
  file: string
  permissions: PermissionSettings
}

export interface ResolvedPermissions {
  mode: PermissionMode
  /** Where the mode came from: "default", a settings file or the flag. */
  modeSource: string
  rules: PermissionRule[]
  warnings: string[]
}

/**
 * The effective permission settings of the layers. A project can only tighten: its mode
 * counts when it is stricter than the user's, its ask and deny rules always apply, and its
 * allow rules only when the project is trusted (`trusted`); each thing left out is warned
 * about. The command line's mode wins over every file: it is the user's own choice.
 */
export function resolvePermissions(
  layers: PermissionLayer[],
  opts: { trusted: boolean },
): ResolvedPermissions {
  const warnings: string[] = []
  const rules: PermissionRule[] = []
  let mode: PermissionMode = "auto"
  let modeSource = "default"
  for (const layer of layers.filter((l) => l.scope === "user")) {
    if (layer.permissions.mode) {
      mode = layer.permissions.mode
      modeSource = layer.file
    }
    for (const r of layer.permissions.rules ?? [])
      rules.push({ ...r, source: { scope: "user", file: layer.file } })
  }
  for (const layer of layers.filter((l) => l.scope === "project")) {
    const wanted = layer.permissions.mode
    if (wanted) {
      if (stricterMode(mode, wanted) === wanted && wanted !== mode) {
        mode = wanted
        modeSource = layer.file
      } else if (wanted !== mode) {
        warnings.push(
          `${layer.file}: "permissions.mode" "${wanted}" is ignored; a project file can only choose a stricter mode than "${mode}"`,
        )
      }
    }
    let dropped = 0
    for (const r of layer.permissions.rules ?? []) {
      if (r.decision === "allow" && !opts.trusted) {
        dropped++
        continue
      }
      rules.push({ ...r, source: { scope: "project", file: layer.file } })
    }
    if (dropped) {
      warnings.push(
        `${layer.file}: ${dropped} "allow" ${dropped === 1 ? "rule is" : "rules are"} ignored; this project is not trusted (amira ext trust trusts it). Its ask and deny rules apply`,
      )
    }
  }
  for (const layer of layers.filter((l) => l.scope === "flags")) {
    if (layer.permissions.mode) {
      mode = layer.permissions.mode
      modeSource = layer.file
    }
  }
  return { mode, modeSource, rules, warnings }
}
