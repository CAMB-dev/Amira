import type { UiApi } from "@amira/api"

type Handler = (text: string) => void
interface Owner {
  active: boolean
  handlers: Set<Handler>
  slot?: AbortController
}

/** One host-owned, local-TUI suggestion. Text and callbacks never cross the event boundary. */
export class InputSuggestions {
  #owners = new Map<string | undefined, Owner>()
  #suggestion: { text: string; owner: Owner; slot?: AbortController } | undefined
  #frontend: { read: () => { revision: number; ready: boolean } } | undefined
  #revision: number | undefined
  #invalidating = false
  #render: () => void
  #busy: () => boolean
  #available: () => boolean

  constructor(render: () => void, busy: () => boolean = () => false, available: () => boolean = () => true) {
    this.#render = render
    this.#busy = busy
    this.#available = available
  }

  get text(): string | undefined {
    return this.#suggestion?.text
  }

  /** Local-only attachment: never called by print, RPC or remote frontend adapters. */
  attach(read: () => { revision: number; ready: boolean }): () => void {
    this.invalidate()
    const frontend = { read }
    this.#frontend = frontend
    this.#revision = read().revision
    return () => {
      if (this.#frontend !== frontend) return
      this.#frontend = undefined
      this.#revision = undefined
      this.invalidate()
    }
  }

  /** Reports monotonic composer changes without transferring any draft content. */
  refresh(): void {
    const state = this.#frontend?.read()
    const changed = state?.revision !== this.#revision
    this.#revision = state?.revision
    if (changed || !state?.ready || this.#busy() || !this.#available()) this.invalidate()
  }

  /** Cancels leases without changing legacy suggestions set while the prompt is hidden. */
  invalidate(): void {
    if (this.#invalidating) return
    this.#invalidating = true
    try {
      for (const owner of this.#owners.values()) this.#abort(owner)
    } finally {
      this.#invalidating = false
    }
  }

  #abort(owner: Owner): void {
    const slot = owner.slot
    owner.slot = undefined
    if (slot && this.#suggestion?.slot === slot) {
      this.#suggestion = undefined
      this.#render()
    }
    const invalidating = this.#invalidating
    this.#invalidating = true
    try {
      slot?.abort()
    } finally {
      this.#invalidating = invalidating
    }
  }

  /** Host dismissal is unconditional and does not notify acceptance listeners. */
  clear(): void {
    this.invalidate()
    this.#dismiss()
  }

  #dismiss(): void {
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

  api(
    source?: string,
  ): Pick<UiApi, "setInputSuggestion" | "acquireInputSuggestionSlot" | "onInputSuggestionAccepted"> {
    let owner = this.#owners.get(source)
    if (!owner) {
      owner = { active: true, handlers: new Set() }
      this.#owners.set(source, owner)
    }
    const lifetime = owner
    const ready = () =>
      lifetime.active &&
      !this.#invalidating &&
      !this.#busy() &&
      this.#available() &&
      this.#frontend?.read().ready === true
    return {
      acquireInputSuggestionSlot: () => {
        this.refresh()
        this.#abort(lifetime)
        if (!ready()) return undefined
        const controller = new AbortController()
        lifetime.slot = controller
        return {
          signal: controller.signal,
          set: (text) => {
            this.refresh()
            if (controller.signal.aborted || lifetime.slot !== controller || !ready()) return false
            const clean = sanitize(text)
            if (clean) this.#suggestion = { text: clean, owner: lifetime, slot: controller }
            else if (this.#suggestion?.owner === lifetime) this.#suggestion = undefined
            this.#render()
            return true
          },
          release: () => {
            if (lifetime.slot === controller) this.#abort(lifetime)
          },
        }
      },
      setInputSuggestion: (text) => {
        if (!lifetime.active) return
        const clean = text === undefined ? undefined : sanitize(text)
        if (!clean) {
          if (this.#suggestion?.owner === lifetime) this.#dismiss()
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
    this.#abort(owner)
    owner.handlers.clear()
    this.#owners.delete(source)
    if (this.#suggestion?.owner === owner) this.#dismiss()
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
