import { statSync } from "node:fs"
import path from "node:path"
import { emptyUsage, type Message, type ModelRef } from "@amira/ai"
import type { SubagentInfo, SubagentState } from "@amira/api"
import type { Agent } from "./agent.ts"
import { SessionStore } from "./session-store.ts"
import type { AgentTree } from "./subagents.ts"

/** A sub-agent as listed for a session, with a way to get its conversation. */
export interface SubagentEntry {
  info: SubagentInfo
  /** Its conversation so far; a copy, so it does not change under the caller. */
  messages(): Message[]
}

/**
 * The sub-agents of `agent`'s session and theirs, depth first (each followed by its own) in
 * start order. Those this process started come from the tree, with their live state; those
 * of earlier runs of a resumed session come from the session files, which the parent's file
 * points at with its "subagent" entries.
 */
export function listSubagents(agent: Agent, tree?: AgentTree): SubagentEntry[] {
  const out: SubagentEntry[] = []
  const seen = new Set<string>()
  const visit = (parentId: string, store: SessionStore | undefined, depth: number) => {
    const stored = store
      ? store.entries.flatMap((e) => (e.type === "subagent" ? [{ id: e.childSessionId, role: e.role }] : []))
      : []
    const ids = [...stored.map((s) => s.id), ...(tree?.childrenOf(parentId) ?? [])]
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      const live = tree?.subagent(id)
      if (live) {
        out.push({ info: { ...live.info, depth }, messages: () => [...live.messages] })
        visit(id, live.session, depth + 1)
        continue
      }
      const role = stored.find((s) => s.id === id)?.role || "agent"
      const file = path.join(path.dirname(store!.file), "subagents", `${id}.jsonl`)
      const child = openStored(file)
      out.push({
        info: storedInfo(id, parentId, depth, role, child),
        messages: () => (child ? [...child.restore().messages] : []),
      })
      if (child) visit(id, child, depth + 1)
    }
  }
  visit(agent.sessionId, agent.session, 1)
  return out
}

/** Stores read from disk, by file, kept while the file does not change. */
const cache = new Map<string, { size: number; mtimeMs: number; store: SessionStore }>()

function openStored(file: string): SessionStore | undefined {
  let stat: { size: number; mtimeMs: number }
  try {
    stat = statSync(file)
  } catch {
    // A sub-agent that never got to say anything leaves no file.
    return undefined
  }
  const hit = cache.get(file)
  if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.store
  try {
    const store = SessionStore.open(file)
    cache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, store })
    return store
  } catch {
    return undefined
  }
}

/** What a finished sub-agent's file says about it. */
function storedInfo(
  id: string,
  parentSessionId: string,
  depth: number,
  role: string,
  store: SessionStore | undefined,
): SubagentInfo {
  const usage = emptyUsage()
  if (!store) return { id, parentSessionId, depth, role, task: "", status: "aborted", usage }
  const messages = store.entries.flatMap((e) => (e.type === "message" ? [e.message] : []))
  let model: ModelRef | undefined
  let status: SubagentState = "aborted"
  for (const m of messages) {
    if (m.role !== "assistant") continue
    model = m.model
    // A reply that asked for tools was the last one only when the run was cut short.
    status =
      m.stopReason === "error"
        ? "error"
        : m.stopReason === "aborted" || m.stopReason === "toolUse"
          ? "aborted"
          : "done"
    if (!m.usage) continue
    usage.input += m.usage.input
    usage.output += m.usage.output
    usage.cacheRead += m.usage.cacheRead
    usage.cacheWrite += m.usage.cacheWrite
    if (m.usage.cost !== undefined) usage.cost = (usage.cost ?? 0) + m.usage.cost
  }
  // A child has one turn: its task is the last user message (a forked one follows the history).
  const task = messages.findLast((m) => m.role === "user")
  const startedAt = Date.parse(store.header.createdAt)
  const last = store.entries.at(-1)?.ts
  return {
    id,
    parentSessionId,
    depth,
    role,
    task: task ? task.content.map((b) => (b.type === "text" ? b.text : "")).join("") : "",
    status,
    ...(model ? { model } : {}),
    ...(Number.isFinite(startedAt) ? { startedAt } : {}),
    ...(Number.isFinite(startedAt) && last !== undefined
      ? { durationMs: Math.max(0, last - startedAt) }
      : {}),
    usage,
  }
}
