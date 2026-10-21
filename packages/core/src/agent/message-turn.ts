import type { Message } from "@amira/ai"

// Host-only identity metadata: never add transport fields to provider messages or session records.
const turns = new WeakMap<Message, string>()

export function rememberMessageTurn(message: Message, turnId: string): void {
  turns.set(message, turnId)
}

export function messageTurnId(message: Message): string | undefined {
  return turns.get(message)
}
