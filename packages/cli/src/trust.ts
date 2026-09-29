import { createInterface } from "node:readline/promises"
import type { Settings } from "@amira/api"
import {
  type ActivePackages,
  activePackages,
  loadSettings,
  packageScope,
  projectPackageNames,
  projectScopeIsUser,
  projectTrust,
  rememberProjectTrust,
} from "@amira/core"

export interface PackagePlan {
  /** The packages to load, read again on each /reload. */
  packages: () => ActivePackages
  /** A problem remembering the answer, for the settings warnings. */
  warning?: string
}

export interface PlanOptions {
  cwd: string
  home?: string
  settings: Settings
  /** --no-packages: none at all. */
  noPackages?: boolean
  /**
   * Asks whether the project's own packages may load, the first time a project has any;
   * unset where nobody can answer (print and rpc mode): they are left out then.
   */
  ask?: (names: string[], dir: string) => Promise<boolean>
}

/**
 * Which packages load: none with --no-packages; else the installed ones minus those settings
 * `packages.disabled` names, and the project's own only once the user trusts the project. That
 * is asked once per project and remembered in the user settings.
 */
export async function planPackages(opts: PlanOptions): Promise<PackagePlan> {
  if (opts.noPackages) return { packages: () => ({ packages: [], problems: [], skipped: [] }) }
  const where = { cwd: opts.cwd, ...(opts.home ? { home: opts.home } : {}) }
  const projectDir = packageScope("project", where).dir
  // Run from the home directory, the project's packages are the user's own.
  let trusted = projectScopeIsUser(where) || projectTrust(opts.cwd, opts.settings)
  let warning: string | undefined
  const names = trusted === undefined ? projectPackageNames(where) : []
  if (trusted === undefined && names.length && opts.ask) {
    trusted = await opts.ask(names, projectDir)
    try {
      rememberProjectTrust(opts.cwd, trusted, opts.home)
    } catch (err) {
      warning = `could not remember whether this project is trusted: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const project = trusted === true
  // Disabling is read again on a reload: `amira ext disable` may have run meanwhile.
  const disabled = () => {
    try {
      return loadSettings({ ...where }).settings.packages?.disabled ?? []
    } catch {
      return opts.settings.packages?.disabled ?? []
    }
  }
  return {
    packages: () => activePackages(where, { disabled: disabled(), project }),
    ...(warning ? { warning } : {}),
  }
}

/** Asks on the terminal, before the UI starts, whether a project's own packages may load. */
export async function askProjectTrust(names: string[], dir: string): Promise<boolean> {
  process.stdout.write(
    `\nThis project has its own extension packages: ${names.join(", ")}\n(in ${dir}). They run code on this computer with your permissions.\nThe answer is remembered for this project; amira ext trust or amira ext untrust changes it.\n\n`,
  )
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question("Load them? [y/N] ")).trim().toLowerCase()
    return answer === "y" || answer === "yes"
  } finally {
    rl.close()
  }
}
