import { type Agent, type AgentPort, MODE_SUMMARY } from "@amira/core"

/** Display-only model facts; absence of image support fails closed for remote sessions. */
export interface DisplayModel {
  provider: string
  id: string
  caps?: { images?: boolean }
}

const cache = new WeakMap<
  AgentPort["snapshot"],
  {
    cwd: string
    sessionId: string
    model: AgentPort["snapshot"]["state"]["model"]
    turnId?: string
    holdId?: string
    messages: AgentPort["snapshot"]["transcript"]["messages"][number]["message"][]
  }
>()

/** A cached projection, never an executable stand-in for a remote Agent. */
export function frontendDisplay(port: AgentPort, agent?: Agent) {
  if (agent) return agent
  const snapshot = port.snapshot
  const cached = cache.get(snapshot)
  if (cached) return cached
  const { state, transcript } = snapshot
  const display = {
    cwd: state.cwd,
    sessionId: state.sessionId,
    model: state.model,
    turnId: state.turnId,
    holdId: state.holdId,
    messages: transcript.messages.map((entry) => entry.message),
  }
  cache.set(snapshot, display)
  return display
}

export function cycleFrontendPermission(port: AgentPort, showNote: (text: string) => void): void {
  void port.execute("permissions.cycle", {}, { sessionGeneration: port.snapshot.sessionGeneration }).then(
    ({ mode }) => showNote(`Permission mode: ${mode} — ${MODE_SUMMARY[mode]}`),
    (error) => showNote(error instanceof Error ? error.message : String(error)),
  )
}

export async function unavailableWorkspaceImage(): Promise<never> {
  throw new Error("Remote workspace image reads are unavailable.")
}
