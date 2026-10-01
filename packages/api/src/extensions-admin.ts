/** Package management for slash commands, supplied by the host. */
export type ExtensionScope = "user" | "project"

export interface ManagedExtension {
  name: string
  version: string
  scope: ExtensionScope
  enabled: boolean
  trusted: boolean
  source: string
  description: string
  error?: string
  shadowed?: boolean
}

export interface AvailableExtension {
  name: string
  version: string
  description: string
}

export interface ExtensionProgress {
  name: string
  phase: string
  detail?: string
  percent?: number
}

export interface ExtensionOperationOptions {
  signal: AbortSignal
  onProgress(progress: ExtensionProgress): void
  log(message: string): void
}

export interface ExtensionUpdate {
  name: string
  version: string
  changed: boolean
  error?: string
}

export interface ExtensionAdmin {
  list(): ManagedExtension[]
  search(
    query: string,
    signal: AbortSignal,
  ): Promise<{ extensions: AvailableExtension[]; warnings: string[] }>
  install(
    name: string,
    scope: ExtensionScope,
    opts: ExtensionOperationOptions,
  ): Promise<{ name: string; version: string; warnings: string[] }>
  update(
    names: string[],
    scope: ExtensionScope,
    opts: ExtensionOperationOptions,
    each: (result: ExtensionUpdate) => void,
  ): Promise<void>
  remove(name: string, scope: ExtensionScope): void
  /** Writes user settings; a name is disabled in both scopes, as in the CLI. */
  setEnabled(name: string, enabled: boolean): boolean
}
