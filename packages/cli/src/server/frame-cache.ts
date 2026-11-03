import { type PreparedRemoteMessage, prepareForPeer, remoteGateKey } from "../remote/peer-compat.ts"
import type { RemoteMessage } from "../remote/protocol.ts"

/**
 * Encodes each live journal event once per gate set instead of once per connection. The journal
 * hands one frozen event to every subscriber in a single synchronous pass, so remembering only
 * the latest event gets every hit while holding at most one encoding per gate set.
 */
export class EventFrameCache {
  #event?: RemoteMessage
  #frames = new Map<string, PreparedRemoteMessage | undefined>()

  prepare(message: RemoteMessage, capabilities: readonly string[]): PreparedRemoteMessage | undefined {
    // Replayed copies are per connection; only shared live events are worth caching.
    if (message.kind !== "event" || message.replay) return prepareForPeer(message, capabilities)
    if (this.#event !== message) {
      this.#event = message
      this.#frames.clear()
    }
    const key = remoteGateKey(capabilities)
    if (!this.#frames.has(key)) this.#frames.set(key, prepareForPeer(message, capabilities))
    return this.#frames.get(key)
  }
}
