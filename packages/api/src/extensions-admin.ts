/**
 * Managing extension packages from a slash command (`/ext`), supplied by the host as
 * SessionControl.extensionAdmin. The same operations and rules as `amira ext`: a project
 * install does not trust the project, disabling writes the user settings, and nothing here
 * loads or reloads code (that is /reload, while the session is idle).
 */
export type ExtensionScope = "user" | "project"

/** A package one of the two scopes' lock files records. */
export interface ManagedExtension {
  name: string
  version: string
  scope: ExtensionScope
  /** Not in `packages.disabled` of the user settings. */
  enabled: boolean
  /** User packages always; a project package once the project is trusted. */
  trusted: boolean
  /** Where it was installed from, for people. */
  source: string
  description: string
  /** Why the package cannot be used, when it cannot. */
  error?: string
  /** A user package hidden by a project package of the same name. */
  shadowed?: boolean
}

/** An entry of the extensions index. */
export interface AvailableExtension {
  name: string
  version: string
  description: string
}

/** What one package is doing, for a progress display; `phase` is the core's install phase. */
export interface ExtensionProgress {
  name: string
  phase: string
  detail?: string
  /** 0 to 100, when the phase reports it. */
  percent?: number
}

export interface ExtensionOperationOptions {
  /** Stops the operation; an install then leaves the old package, or none. */
  signal: AbortSignal
  onProgress(progress: ExtensionProgress): void
  /** Warnings, e.g. that a cached index was used. */
  log(message: string): void
}

/** One package's update: what it is at now, or why it could not move (the installed one is kept). */
export interface ExtensionUpdate {
  name: string
  version: string
  changed: boolean
  error?: string
}

export interface ExtensionAdmin {
  /** Every installed package of both scopes, user scope first. */
  list(): ManagedExtension[]
  /** Searches the index; an empty query lists it. Throws when it cannot be loaded. */
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<{ extensions: AvailableExtension[]; warnings: string[] }>
  /** Installs a name from the index (or a source, as the CLI takes); reinstalling refreshes. */
  install(
    name: string,
    scope: ExtensionScope,
    opts: ExtensionOperationOptions,
  ): Promise<{ name: string; version: string; warnings: string[] }>
  /** Updates the named packages of a scope, or all of them with no names; `each` hears of each. */
  update(
    names: string[],
    scope: ExtensionScope,
    opts: ExtensionOperationOptions,
    each: (result: ExtensionUpdate) => void,
  ): Promise<void>
  /** Deletes the package's files and lock entry; throws when it is not in that scope. */
  remove(name: string, scope: ExtensionScope): void
  /** Writes user settings; a name is disabled in both scopes, as in the CLI. Whether it changed. */
  setEnabled(name: string, enabled: boolean): boolean
}
