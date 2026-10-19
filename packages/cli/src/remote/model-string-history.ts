import { ModelOutboundError } from "./model-codec.ts"
import { maskModelFragments } from "./model-string-masks.ts"
import { secretPatterns } from "./secret-patterns.ts"

const firstCharacters = new WeakMap<readonly string[], ReadonlySet<string>>()

/** Bounded proper-prefix states also protect two free-form fields separated by other fields.
 * This is not arbitrary character-subsequence matching: each continuation consumes a whole
 * field, or completes a secret at its leading edge. State survives continuing flushes.
 */
export class ModelStringHistory {
  private states: (Set<number> | undefined)[]
  private starts: ReadonlySet<string>
  constructor(private secrets: readonly string[]) {
    this.states = new Array(secrets.length)
    this.starts = firstCharacters.get(secrets) ?? new Set(secrets.map((secret) => secret[0]!))
    firstCharacters.set(secrets, this.starts)
  }

  fork(): ModelStringHistory {
    const copy = new ModelStringHistory(this.secrets)
    copy.states = this.states.map((states) => (states ? new Set(states) : undefined))
    return copy
  }

  /** Numeric observations cannot be rewritten. Keep every equivalent-rendering branch. */
  immutable(representations: readonly string[]): void {
    const patterns = secretPatterns(this.secrets)
    if (representations.some((value) => patterns.contains(value))) throw new ModelOutboundError(true)
    if (representations.length === 1) {
      const value = representations[0]!
      if (![...value].some((character) => this.starts.has(character))) {
        // A common numeric counter cannot start any credential in this snapshot. It
        // only needs to advance/check the already-live prefix states, not rescan every
        // suffix against every secret for every generated receipt counter.
        for (let index = 0; index < this.states.length; index++) {
          const states = this.states[index]
          if (!states) continue
          const secret = this.secrets[index]!
          for (const prefix of [...states]) {
            const rest = secret.slice(prefix)
            if (value.startsWith(rest)) throw new ModelOutboundError(true)
            if (prefix + value.length < secret.length && rest.startsWith(value))
              states.add(prefix + value.length)
          }
        }
        return
      }
      if (this.mask(value) !== value) throw new ModelOutboundError(true)
      return
    }
    const combined = this.fork()
    for (const value of representations) {
      const branch = this.fork()
      if (branch.mask(value) !== value) throw new ModelOutboundError(true)
      for (let index = 0; index < branch.states.length; index++) {
        const states = branch.states[index]
        if (!states) continue
        combined.states[index] ??= new Set()
        for (const state of states) combined.states[index]!.add(state)
      }
    }
    this.states = combined.states
  }

  mask(value: string): string {
    if (!value || !this.secrets.length) return value
    let text = value
    while (true) {
      let consumed = 0
      for (let index = 0; index < this.secrets.length; index++) {
        const secret = this.secrets[index]!
        const states = this.states[index]
        if (!states) continue
        for (const prefix of states) {
          const rest = secret.slice(prefix)
          if (text.startsWith(rest)) consumed = Math.max(consumed, rest.length)
        }
      }
      if (!consumed) break
      // Do not insert a marker that could itself complete an already published prefix.
      text = maskModelFragments([text.slice(consumed)], this.secrets)[0]!
    }
    if (!text) return text
    for (let index = 0; index < this.secrets.length; index++) {
      const secret = this.secrets[index]!
      let states = this.states[index]
      for (const prefix of states ? [...states] : []) {
        if (prefix + text.length < secret.length && secret.slice(prefix).startsWith(text))
          states!.add(prefix + text.length)
      }
      for (let length = 1; length < secret.length && length <= text.length; length++) {
        if (!secret.startsWith(text.slice(-length))) continue
        states ??= this.states[index] = new Set()
        states.add(length)
      }
    }
    return text
  }
}
