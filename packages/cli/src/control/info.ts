import { existsSync } from "node:fs"
import { isNoModel, userMessage } from "@amira/ai"
import { type AssistantMessage, type SessionControl, USER_STOP_REASON } from "@amira/api"
import { listSubagents, subagentMessages } from "@amira/core"
import { withProviderHint } from "../provider-command.ts"
import type { ControlContext } from "./context.ts"

type InfoControl = Pick<
  SessionControl,
  | "info"
  | "messages"
  | "contextHas"
  | "replies"
  | "compactions"
  | "sideRequests"
  | "subagents"
  | "subagentMessages"
  | "stopSubagent"
  | "createGroup"
  | "data"
  | "groups"
  | "expectNotice"
  | "models"
  | "setModel"
  | "compact"
  | "send"
  | "preview"
  | "artifacts"
>

export function createInfoControl(ctx: ControlContext): InfoControl {
  return {
    info: () => {
      const a = ctx.agent()
      const file = a.session?.file
      // Shown only when it is sent: a model that does not think never gets an effort.
      const thinking = a.model.caps.thinking ? a.thinkingFor(a.model) : undefined
      return {
        id: a.sessionId,
        ...(a.session?.title ? { title: a.session.title } : {}),
        cwd: a.cwd,
        model: { provider: a.model.provider, model: a.model.id },
        ...(thinking ? { thinking } : {}),
        contextWindow: a.model.contextWindow,
        ...(a.model.contextWindowSource ? { contextWindowSource: a.model.contextWindowSource } : {}),
        ...(a.contextTokens !== undefined ? { contextTokens: a.contextTokens } : {}),
        ...(file && existsSync(file) ? { file } : {}),
        busy: a.busy,
        shell: ctx.shell.get(),
        permissions: { mode: a.permissions.mode, rules: a.permissions.rules.length },
      }
    },
    messages: () => ctx.agent().messages,
    contextHas: (text) => ctx.agent().contextHas(text),
    replies: () => {
      const a = ctx.agent()
      // The session file keeps messages a compaction replaced, so their cost still counts.
      const all = a.session
        ? a.session.entries.flatMap((e) => (e.type === "message" ? [e.message] : []))
        : a.messages
      return all.filter((m): m is AssistantMessage => m.role === "assistant")
    },
    compactions: () => ctx.agent().compactionUsage,
    sideRequests: () =>
      (ctx.agent().session?.entries ?? []).flatMap((e) =>
        e.type === "side_usage"
          ? [{ model: e.model, usage: e.usage, ...(e.label ? { label: e.label } : {}) }]
          : [],
      ),
    subagents: () => listSubagents(ctx.agent(), ctx.session.tree).map((e) => e.info),
    subagentMessages: (id) => subagentMessages(ctx.agent(), ctx.session.tree, id),
    stopSubagent: (id) =>
      listSubagents(ctx.agent(), ctx.session.tree).some((e) => e.info.id === id) &&
      ctx.session.tree.stop(id, USER_STOP_REASON),
    createGroup: (groupOpts) => ctx.session.tree.createGroup(ctx.agent(), groupOpts),
    data: {
      append: (key, data) => ctx.agent().data.append(key, data),
      read: (key) => ctx.agent().data.read(key),
    },
    groups: () => ctx.session.tree.groups(),
    expectNotice: () => ctx.agent().expectNotice(),
    models: () => {
      const m = ctx.agent().model
      // NO_MODEL is no choice to offer.
      const current = isNoModel(m) ? [] : [`${m.provider}/${m.id}`]
      return [...new Set([...current, ...ctx.ai.knownModels()])]
    },
    setModel: (ref) => {
      ctx.idle("switch models")
      try {
        ctx.agent().setModel(ctx.ai.model(ref))
      } catch (err) {
        throw new Error(withProviderHint(err instanceof Error ? err.message : String(err)))
      }
    },
    compact: (instructions) => {
      ctx.idle("compact")
      return ctx.agent().compact(instructions)
    },
    send: async (text, sendOpts) => {
      const a = ctx.agent()
      const message = userMessage(text, sendOpts?.display)
      // steer() queues during a turn or a /compact; prompt() only runs when idle.
      if (a.busy) a.steer(message)
      else await a.prompt(message)
    },
    preview: () => ctx.agent().preview(),
    artifacts: {
      usage: () => {
        const a = ctx.agent()
        const u = a.artifactUsage()
        return {
          active: u.active.length,
          inactive: u.inactive.length,
          unused: u.unused.length,
          pruned: u.pruned.length,
          bytes: u.bytes,
          quotaBytes: a.artifacts.quotaBytes,
          dir: a.artifacts.dir,
          ...(u.groups ? { groups: u.groups } : {}),
        }
      },
      prune: async (scope) => {
        // A running turn may have saved outputs its results do not mention yet, or be reading one.
        ctx.idle("prune artifacts")
        return ctx.agent().pruneArtifacts(scope)
      },
    },
  }
}
