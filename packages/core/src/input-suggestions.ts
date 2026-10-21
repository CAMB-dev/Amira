import type { UiApi } from "@amira/api"

type Handler = (text: string) => void
interface Owner {
  active: boolean
  handlers: Set<Handler>
}

/** One host-owned, local-TUI suggestion. Text and callbacks never cross the event boundary. */
export class InputSuggestions {
  #owners = new Map<string | undefined, Owner>()
  #suggestion: { text: string; owner: Owner } | undefined
  #render: () => void
  #busy: () => boolean

  constructor(render: () => void, busy: () => boolean = () => false) {
    this.#render = render
    this.#busy = busy
  }

  get text(): string | undefined {
    return this.#suggestion?.text
  }

  /** Host dismissal is unconditional and does not notify acceptance listeners. */
  clear(): void {
    if (!this.#suggestion) return
    this.#suggestion = undefined
    this.#render()
  }

  /** Takes the suggestion before notifying only its owner's still-live listeners. */
  accept(): string | undefined {
    const suggestion = this.#suggestion
    if (!suggestion) return undefined
    this.clear()
    const { text, owner } = suggestion
    for (const handler of [...owner.handlers]) {
      if (!owner.active || !owner.handlers.has(handler)) continue
      try {
        Promise.resolve(handler(text)).catch(() => {})
      } catch {
        // Extension callbacks must not break input handling or prevent other listeners.
      }
    }
    return text
  }

  api(source?: string): Pick<UiApi, "setInputSuggestion" | "onInputSuggestionAccepted"> {
    let owner = this.#owners.get(source)
    if (!owner) {
      owner = { active: true, handlers: new Set() }
      this.#owners.set(source, owner)
    }
    const lifetime = owner
    return {
      setInputSuggestion: (text) => {
        if (!lifetime.active) return
        const clean = text === undefined ? undefined : sanitize(text)
        if (!clean) {
          if (this.#suggestion?.owner === lifetime) this.clear()
          return
        }
        // A late prediction must not survive a turn/hold already in progress.
        if (this.#busy()) {
          this.clear()
          return
        }
        this.#suggestion = { text: clean, owner: lifetime }
        this.#render()
      },
      onInputSuggestionAccepted: (handler) => {
        if (!lifetime.active) return () => {}
        const listener: Handler = (text) => handler(text)
        lifetime.handlers.add(listener)
        return () => void lifetime.handlers.delete(listener)
      },
    }
  }

  /** Invalidates old API handles, including when this source is subsequently loaded again. */
  release(source: string): void {
    const owner = this.#owners.get(source)
    if (!owner) return
    owner.active = false
    owner.handlers.clear()
    this.#owners.delete(source)
    if (this.#suggestion?.owner === owner) this.clear()
  }
}

function sanitize(text: string): string {
  // Strip terminal strings as well as CSI/OSC sequences, then normalize all line whitespace.
  const plain = text
    .replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes and C1 equivalents
      /(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)|(?:\x1b[P_^X]|[\x90\x98\x9e\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]/g,
      "",
    )
    .replace(/[\s\u0085]+/gu, " ")
    .replace(/[\p{Cc}\p{Bidi_Control}\u200b\u2060-\u206f]/gu, "")
    .trim()
  return Array.from(plain).slice(0, 500).join("").trim()
}
