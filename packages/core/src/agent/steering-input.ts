// Host-only access to the real turn inbox. This is sampled, never reconstructed from events.
import type { UserMessage } from "@amira/ai"
import type { Agent } from "../agent.ts"
import { freezeSnapshot, frontendJson } from "../frontend/json.ts"

const sources = new WeakMap<Agent, () => readonly UserMessage[]>()

export function registerSteeringInput(agent: Agent, source: () => readonly UserMessage[]): void {
  sources.set(agent, source)
}

export function steeringInputSnapshot(agent: Agent): readonly UserMessage[] {
  return freezeSnapshot(frontendJson(sources.get(agent)?.() ?? [])) as unknown as readonly UserMessage[]
}
