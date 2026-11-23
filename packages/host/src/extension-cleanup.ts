import type { OwnedConversationManager } from "./owned-conversations.ts"

/** Awaited host cleanup behind the synchronous extension unload contract. */
export class ExtensionCleanup {
  #pending = new Set<Promise<void>>()

  constructor(private report: (source: string, message: string) => void) {}

  track(source: string, work: Promise<void>): void {
    const cleanup = work.catch((error) => {
      this.report(
        source,
        `conversation cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    this.#pending.add(cleanup)
    void cleanup.finally(() => this.#pending.delete(cleanup))
  }

  release(manager: OwnedConversationManager, owner: string, source: string): void {
    this.track(source, manager.releaseOwner(owner))
  }

  async drain(): Promise<void> {
    while (this.#pending.size) await Promise.all([...this.#pending])
  }
}
