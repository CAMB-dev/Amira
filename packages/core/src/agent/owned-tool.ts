import type { ToolResultMessage } from "@amira/ai"
import type { SessionStatus, ToolResult } from "@amira/api"
import type { Agent } from "../agent.ts"
import type { AgentTree } from "../subagents.ts"
import type { ToolRunner } from "./tool-runner.ts"
import type { TurnState } from "./turn-runner.ts"
import { AgentAbortedError, AgentBusyError, type Turn } from "./types.ts"

interface OwnedToolOutcome {
  result: ToolResult
  aborted: boolean
}
const runners = new WeakMap<Agent, OwnedToolRunner>()
const ownedTrees = new WeakSet<AgentTree>()

/** Internal owner binding; do not add an unbound invocation method to Agent's public API. */
export function runOwnedTool(
  agent: Agent,
  name: string,
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<OwnedToolOutcome> {
  const runner = runners.get(agent)
  if (!runner) return Promise.reject(new Error("owned tool runner is unavailable"))
  return runner.run(name, args, options)
}

export async function drainOwnedTools(agent: Agent): Promise<void> {
  await runners.get(agent)?.drain()
}

/** Between-turn tool execution, with distinct durable evidence and the ordinary call pipeline. */
export class OwnedToolRunner {
  current: Promise<OwnedToolOutcome> | undefined

  constructor(
    private readonly agent: Agent,
    private readonly state: TurnState,
    private readonly runner: ToolRunner,
    private readonly status: (turn: Turn, status: SessionStatus) => void,
    private readonly disposed: () => boolean,
  ) {
    runners.set(agent, this)
    if (agent.session?.header.owned && agent.tree) ownedTrees.add(agent.tree)
  }

  /** Includes owned descendants, even private children without a session store. */
  async drain(): Promise<void> {
    if (this.agent.session?.header.owned || (this.agent.tree && ownedTrees.has(this.agent.tree)))
      await this.runner.drain()
  }

  run(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<OwnedToolOutcome> {
    const { agent, state } = this
    if (this.disposed()) return Promise.reject(new AgentAbortedError("the session has ended"))
    if (!agent.session?.header.owned || agent.depth !== 0)
      return Promise.reject(new Error("tool invocation requires an owned conversation"))
    if (agent.busy) return Promise.reject(new AgentBusyError("a turn or tool operation is already running"))
    const controller = new AbortController()
    const abort = () => controller.abort(options?.signal?.reason)
    if (options?.signal?.aborted) abort()
    else options?.signal?.addEventListener("abort", abort, { once: true })
    const turn: Turn = { id: `o_${crypto.randomUUID()}`, signal: controller.signal }
    state.abort = controller
    state.turn = turn
    const operation = (async (): Promise<OwnedToolOutcome> => {
      // Reserve synchronously, but allow the owning handle to register its operation first.
      await Promise.resolve()
      this.status(turn, "working")
      try {
        const call = {
          type: "toolCall" as const,
          id: `c_${crypto.randomUUID()}`,
          name,
          args: structuredClone(args),
        }
        agent.session!.appendDurable({
          type: "custom",
          ext: "amira.tool-operations",
          data: { v: 1, phase: "start", operationId: turn.id, call, at: Date.now() },
        })
        let output: ToolResult | undefined
        let saved: ToolResultMessage | undefined
        await agent.execution.tools(() =>
          this.runner.run(
            turn,
            [call],
            (results, outputs) => {
              output = outputs[0]
              saved = results[0]
            },
            {
              preserveErrors: true,
              beforeExecute: (authorized, finalArgs) => {
                agent.session!.appendDurable({
                  type: "custom",
                  ext: "amira.tool-operations",
                  data: {
                    v: 1,
                    phase: "execute",
                    operationId: turn.id,
                    call: { ...authorized, args: finalArgs },
                    at: Date.now(),
                  },
                })
              },
            },
          ),
        )
        await this.drain()
        agent.session!.appendDurable({
          type: "custom",
          ext: "amira.tool-operations",
          data: {
            v: 1,
            phase: "end",
            operationId: turn.id,
            result: saved,
            aborted: turn.signal.aborted,
            at: Date.now(),
          },
        })
        return { result: output!, aborted: turn.signal.aborted }
      } catch (error) {
        return {
          result: {
            content: [
              {
                type: "text",
                text: `Tool invocation failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          },
          aborted: turn.signal.aborted,
        }
      } finally {
        await this.drain()
        options?.signal?.removeEventListener("abort", abort)
        this.status(turn, "idle")
        state.turn = undefined
        state.abort = undefined
        this.current = undefined
      }
    })()
    this.current = operation
    return operation
  }
}
