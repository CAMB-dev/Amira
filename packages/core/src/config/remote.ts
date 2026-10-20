import {
  DEFAULT_REMOTE_IDLE_TIMEOUT_MS,
  DEFAULT_REMOTE_PROXY_RECONNECT_TIMEOUT_MS,
  type Settings,
} from "@amira/api"
import { validateSettings } from "./schema.ts"

/** Resolve remote-host settings at the consumer without adding defaults to settings provenance. */
export function resolveRemoteSettings(settings: Settings): Required<NonNullable<Settings["remote"]>> {
  // Also check programmatic/flag values, which need not have passed the file schema.
  const remote = validateSettings(
    { remote: settings.remote === undefined ? {} : settings.remote },
    "remote settings",
  ).settings.remote
  return {
    idleTimeoutMs: remote?.idleTimeoutMs ?? DEFAULT_REMOTE_IDLE_TIMEOUT_MS,
    proxyReconnectTimeoutMs: remote?.proxyReconnectTimeoutMs ?? DEFAULT_REMOTE_PROXY_RECONNECT_TIMEOUT_MS,
  }
}
