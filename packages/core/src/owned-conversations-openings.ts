/** Open-time acquisition is owned work too: unload must cancel and drain it. */
export class ConversationOpenings {
  #pending = new Set<{ owner: string; abort: AbortController; done: Promise<void> }>()

  begin(owner: string): { signal: AbortSignal; finish: () => void } {
    const abort = new AbortController()
    let finish!: () => void
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const entry = { owner, abort, done }
    this.#pending.add(entry)
    return {
      signal: abort.signal,
      finish: () => {
        this.#pending.delete(entry)
        finish()
      },
    }
  }

  async stop(owner?: string): Promise<void> {
    const pending = [...this.#pending].filter((entry) => owner === undefined || entry.owner === owner)
    for (const entry of pending) entry.abort.abort(new Error("owned conversation owner has been released"))
    await Promise.all(pending.map((entry) => entry.done))
  }
}
