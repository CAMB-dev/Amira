import { existsSync, statSync } from "node:fs"
import { isNoModel, userMessage } from "@amira/ai"
import { type AssistantMessage, type SessionControl, type ShellMode, USER_STOP_REASON } from "@amira/api"
import {
  type Agent,
  CommandHost,
  findSession,
  listSessions,
  listSubagents,
  SessionStore,
  storedHistory,
  subagentMessages,
  subagentsOf,
} from "@amira/core"
import { createProviderAdmin } from "./provider-admin.ts"
import { withProviderHint } from "./provider-command.ts"
import type { Session } from "./session.ts"
import { toolsToDisable } from "./session.ts"

export interface ControlOptions {
  session: Session
  cwd: string
  /** Shell mode the session starts with (D68). Default auto. */
  shell?: ShellMode
  /** Tools settings or flags disabled explicitly (tools.disabled, --disable-tools). */
  disabled?: string[]
  /** Amira's user directory, for /provider add. Default: $AMIRA_HOME or ~/.amira. */
  home?: string
  platform?: string
  /** The user's command aliases (settings commandAliases). */
  aliases?: Record<string, string>
  /** Announces a session the commands switched to, e.g. agent.start() plus git tracking. */
  announce?: (agent: Agent, reason: "resume" | "clear") => void
}

/**
 * The session control handed to slash commands, and the CommandHost frontends use. It owns
 * which agent is active: /clear and /resume make new agents on the same bus and registries.
 */
export function createCommandHost(opts: ControlOptions): CommandHost {
  const { session, cwd } = opts
  const { ai } = session
  const tools = session.agent.tools
  const platform = opts.platform ?? process.platform
  let shell: ShellMode = opts.shell ?? "auto"
  // Per-session choices from /tools; they win over settings and the shell mode.
  const turnedOff = new Set<string>()
  const turnedOn = new Set<string>()
  const applyDisabled = () => {
    const off = new Set([...toolsToDisable(shell, opts.disabled ?? []), ...turnedOff])
    for (const name of turnedOn) off.delete(name)
    tools.setDisabled(off)
  }

  const agent = () => host.agent
  const idle = (what: string) => {
    const a = agent()
    if (!a.busy) return
    const running = a.turnId ? "a turn" : `a ${a.holdingFor ?? "compaction"}`
    throw new Error(`${running} is running; ${what} after it ends (or press Esc to stop it)`)
  }
  const switchTo = (next: Agent, reason: "resume" | "clear") => {
    // Nobody reads the old conversation any more: no resend of its held notices.
    agent().cancelNoticeRetry()
    host.switchTo(next)
    opts.announce?.(next, reason)
  }

  const control: SessionControl = {
    info: () => {
      const a = agent()
      const file = a.session?.file
      return {
        id: a.sessionId,
        cwd: a.cwd,
        model: { provider: a.model.provider, model: a.model.id },
        contextWindow: a.model.contextWindow,
        ...(a.model.contextWindowSource ? { contextWindowSource: a.model.contextWindowSource } : {}),
        ...(a.contextTokens !== undefined ? { contextTokens: a.contextTokens } : {}),
        ...(file && existsSync(file) ? { file } : {}),
        busy: a.busy,
        shell,
      }
    },
    messages: () => agent().messages,
    replies: () => {
      const a = agent()
      // The session file keeps messages a compaction replaced, so their cost still counts.
      const all = a.session
        ? a.session.entries.flatMap((e) => (e.type === "message" ? [e.message] : []))
        : a.messages
      return all.filter((m): m is AssistantMessage => m.role === "assistant")
    },
    subagents: () => listSubagents(agent(), session.tree).map((e) => e.info),
    subagentMessages: (id) => subagentMessages(agent(), session.tree, id),
    stopSubagent: (id) =>
      listSubagents(agent(), session.tree).some((e) => e.info.id === id) &&
      session.tree.stop(id, USER_STOP_REASON),
    createGroup: (groupOpts) => session.tree.createGroup(agent(), groupOpts),
    data: {
      append: (key, data) => agent().data.append(key, data),
      read: (key) => agent().data.read(key),
    },
    groups: () => session.tree.groups(),
    expectNotice: () => agent().expectNotice(),
    models: () => {
      const m = agent().model
      // NO_MODEL is no choice to offer.
      const current = isNoModel(m) ? [] : [`${m.provider}/${m.id}`]
      return [...new Set([...current, ...ai.knownModels()])]
    },
    setModel: (ref) => {
      idle("switch models")
      try {
        agent().setModel(ai.model(ref))
      } catch (err) {
        throw new Error(withProviderHint(err instanceof Error ? err.message : String(err)))
      }
    },
    newSession: async () => {
      idle("start a new session")
      switchTo(session.resume(SessionStore.create({ cwd }), agent().model), "clear")
    },
    sessions: () =>
      listSessions(cwd).map((s) => ({
        id: s.id,
        updatedAt: s.updatedAt,
        firstUserText: s.firstUserText,
        messageCount: s.messageCount,
      })),
    readSession: (id) => {
      // The current session from memory: its file may lag behind (or have stopped saving).
      const live = id === agent().sessionId ? agent().session : undefined
      const file = live?.file ?? findSession(cwd, id)
      if (!file) return undefined
      let store: SessionStore
      let updatedAt: number
      try {
        store = live ?? SessionStore.open(file)
        updatedAt = live ? Date.now() : statSync(file).mtimeMs
      } catch {
        return undefined
      }
      const createdAt = Date.parse(store.header.createdAt)
      const entries = subagentsOf(store.id, store, session.tree)
      return {
        id: store.id,
        cwd: store.header.cwd,
        createdAt: Number.isFinite(createdAt) ? createdAt : updatedAt,
        updatedAt,
        messages: storedHistory(store),
        subagents: entries.map((e) => e.info),
        subagentMessages: (childId) => entries.find((e) => e.info.id === childId)?.history(),
      }
    },
    resume: async (id) => {
      idle("resume another session")
      if (id === agent().sessionId) throw new Error(`already in session ${id}`)
      const file = findSession(cwd, id)
      if (!file) throw new Error(`no session ${id} in ${cwd}`)
      switchTo(session.resume(SessionStore.open(file), agent().model), "resume")
    },
    rewind: async (index) => {
      idle("rewind the conversation")
      const a = agent()
      const store = a.session
      if (!store) throw new Error("this session is not stored, so it cannot be rewound")
      const message = Number.isInteger(index) ? a.messages[index] : undefined
      if (message?.role !== "user")
        throw new Error(`message ${index} is not a user message of this conversation`)
      const id = a.entryId(message)
      const entry = id ? store.get(id) : undefined
      if (entry?.type !== "message") {
        throw new Error("that message was summarized by a compaction; only later ones can be rewound to")
      }
      // Nothing came before it: back to an empty conversation, still in this session.
      store.append({ type: "checkout", target: entry.parentId })
      switchTo(session.resume(store, a.model), "resume")
    },
    compact: (instructions) => {
      idle("compact")
      return agent().compact(instructions)
    },
    send: async (text, sendOpts) => {
      const a = agent()
      const message = userMessage(text, sendOpts?.display)
      // steer() queues during a turn or a /compact; prompt() only runs when idle.
      if (a.busy) a.steer(message)
      else await a.prompt(message)
    },
    tools: () =>
      tools
        .list()
        .map(({ tool, source, disabled }) => ({
          name: tool.name,
          description: tool.description,
          source,
          exposure: tool.exposure ?? "active",
          enabled: !disabled,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    setToolEnabled: (name, enabled) => {
      if (!tools.has(name)) throw new Error(`no tool named "${name}"`)
      ;(enabled ? turnedOn : turnedOff).add(name)
      ;(enabled ? turnedOff : turnedOn).delete(name)
      applyDisabled()
    },
    setShell: (mode) => {
      if (mode !== "auto" && mode !== "bash" && mode !== "powershell") {
        throw new Error(`shell must be auto, bash or powershell, got "${mode}"`)
      }
      if (mode === "powershell" && platform !== "win32") {
        throw new Error("the powershell tool is only available on Windows")
      }
      shell = mode
      // The shell mode decides these two again, over earlier /tools choices.
      for (const name of ["bash", "powershell"]) {
        turnedOn.delete(name)
        turnedOff.delete(name)
      }
      applyDisabled()
    },
    providers: () =>
      ai.providers().map((p) => ({
        id: p.id,
        dialect: p.dialect,
        baseUrl: p.baseUrl,
        ...(p.apiKeyEnv ? { apiKeyEnv: p.apiKeyEnv } : {}),
        hasKey: ai.hasKey(p.id),
      })),
    providerAdmin: createProviderAdmin({
      ai,
      ...(opts.home ? { home: opts.home } : {}),
      platform,
      currentProvider: () => agent().model.provider,
      // A first provider is used at once, and an edit of the one in use applies at once:
      // neither needs /model. Not during a turn; /model does it then.
      onSaved: (id, models) => {
        const a = agent()
        if (a.busy) return undefined
        const m = a.model
        const ref = isNoModel(m)
          ? models[0] && `${id}/${models[0]}`
          : m.provider === id
            ? `${id}/${models.length && !models.includes(m.id) ? models[0] : m.id}`
            : undefined
        if (!ref) return undefined
        try {
          a.setModel(ai.model(ref))
          return ref
        } catch {
          return undefined
        }
      },
    }),
    preview: () => agent().preview(),
    reloadExtensions: async () => {
      // Unloading drops tools and MCP connections a running tool call may still be using.
      idle("reload extensions")
      // Held like a compaction: a prompt or notice meanwhile would reach the model with the
      // tools half loaded, so it waits for the reload and starts its turn after.
      const a = agent()
      return a.hold("reload", () => session.reload(a))
    },
  }

  const host = new CommandHost({
    registry: session.host.commands,
    skills: session.host.skills,
    inputs: session.host.inputs,
    bus: session.agent.bus,
    ui: session.host.ui,
    control,
    agent: session.agent,
    ...(opts.aliases ? { aliases: opts.aliases } : {}),
  })
  return host
}
