/** Open-time acquisition is owned work too: unload must cancel and drain it. */
export class ConversationOpenings {
  #pending = new Set<{ owner: string; id: string; abort: AbortController; done: Promise<void> }>()

  begin(owner: string, id: string): { signal: AbortSignal; finish: () => void } {
    const abort = new AbortController()
    let finish!: () => void
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const entry = { owner, id, abort, done }
    this.#pending.add(entry)
    return {
      signal: abort.signal,
      finish: () => {
        this.#pending.delete(entry)
        finish()
      },
    }
  }

  async stop(owner?: string, id?: string): Promise<void> {
    const pending = [...this.#pending].filter(
      (entry) => (owner === undefined || entry.owner === owner) && (id === undefined || entry.id === id),
    )
    for (const entry of pending)
      entry.abort.abort(
        new Error(
          id === undefined
            ? "owned conversation owner has been released"
            : "owned conversation archive admission has been closed",
        ),
      )
    await Promise.all(pending.map((entry) => entry.done))
  }
}
