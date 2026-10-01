import { existsSync, statSync } from "node:fs"
import path from "node:path"
import { isNoModel, userMessage } from "@amira/ai"
import { type AssistantMessage, type SessionControl, type ShellMode, USER_STOP_REASON } from "@amira/api"
import {
  type Agent,
  CommandHost,
  copyFileHistory,
  createExtensionAdmin,
  deleteSession,
  FILE_REWIND_COVERAGE,
  FileRewindConflictError,
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
  announce?: (agent: Agent, reason: "resume" | "clear" | "fork") => void
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
  const directory = () => (agent().session ? path.dirname(agent().session!.file) : undefined)
  const idle = (what: string) => {
    const a = agent()
    if (!a.busy) return
    const running = a.turnId ? "a turn" : `a ${a.holdingFor ?? "compaction"}`
    throw new Error(`${running} is running; ${what} after it ends (or press Esc to stop it)`)
  }
  const switchTo = (next: Agent, reason: "resume" | "clear" | "fork") => {
    // Nobody reads the old conversation any more: no resend of its held notices.
    agent().cancelNoticeRetry()
    host.switchTo(next)
    opts.announce?.(next, reason)
  }
  const rewindEntry = (index: number) => {
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
    return { a, store, entry }
  }
  const idleFiles = () => {
    if (agent().fileRewind?.busy) throw new Error("file tools are still running; wait for them to finish")
    if (
      listSubagents(agent(), session.tree).some((e) => ["running", "queued", "idle"].includes(e.info.status))
    ) {
      throw new Error("stop this session's active sub-agents before rewinding or pruning file history")
    }
  }

  const control: SessionControl = {
    info: () => {
      const a = agent()
      const file = a.session?.file
      return {
        id: a.sessionId,
        ...(a.session?.title ? { title: a.session.title } : {}),
        cwd: a.cwd,
        model: { provider: a.model.provider, model: a.model.id },
        contextWindow: a.model.contextWindow,
        ...(a.model.contextWindowSource ? { contextWindowSource: a.model.contextWindowSource } : {}),
        ...(a.contextTokens !== undefined ? { contextTokens: a.contextTokens } : {}),
        ...(file && existsSync(file) ? { file } : {}),
        busy: a.busy,
        shell,
        permissions: { mode: a.permissions.mode, rules: a.permissions.rules.length },
      }
    },
    permissions: () => {
      const p = agent().permissions
      return {
        mode: p.mode,
        modeSource: p.modeSource,
        rules: p.rules.map((r) => ({
          command: [...r.command],
          decision: r.decision,
          ...(r.reason ? { reason: r.reason } : {}),
          scope: r.source.scope,
          file: r.source.file,
        })),
        warnings: [...p.warnings],
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
    compactions: () => agent().compactionUsage,
    sideRequests: () =>
      (agent().session?.entries ?? []).flatMap((e) =>
        e.type === "side_usage" ? [{ model: e.model, usage: e.usage }] : [],
      ),
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
      switchTo(session.resume(SessionStore.create({ cwd, dir: directory() }), agent().model), "clear")
    },
    sessions: () =>
      listSessions(cwd, directory()).map((s) => ({
        id: s.id,
        updatedAt: s.updatedAt,
        firstUserText: s.firstUserText,
        ...(s.title ? { title: s.title } : {}),
        searchText: s.searchText,
        messageCount: s.messageCount,
      })),
    readSession: (id) => {
      // The current session from memory: its file may lag behind (or have stopped saving).
      const live = id === agent().sessionId ? agent().session : undefined
      const file = live?.file ?? findSession(cwd, id, directory())
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
      const file = findSession(cwd, id, directory())
      if (!file) throw new Error(`no session ${id} in ${cwd}`)
      switchTo(session.resume(SessionStore.open(file), agent().model), "resume")
    },
    rename: (title) => {
      const a = agent()
      if (!a.session) throw new Error("this session is not stored")
      a.session.rename(title)
      a.bus.emit("session.title", { title: a.session.title ?? "" }, { sessionId: a.sessionId })
    },
    deleteSession: async (id) => {
      idle("delete a session")
      deleteSession(cwd, id, agent().sessionId, directory())
    },
    fork: async (index) => {
      idle("fork the conversation")
      const a = agent()
      const store = a.session
      if (!store) throw new Error("this session is not stored")
      let target = store.leafId
      if (index !== undefined) {
        const message = Number.isInteger(index) ? a.messages[index] : undefined
        if (message?.role !== "user") throw new Error(`message ${index} is not a user message`)
        const id = a.entryId(message)
        const entry = id ? store.get(id) : undefined
        if (entry?.type !== "message") throw new Error("that message was summarized by a compaction")
        target = entry.parentId
      }
      if (a.fileRewind?.restoring)
        throw new Error("finish or abandon the interrupted file restore before forking")
      const forked = store.fork(target)
      // The copied journal keeps working: the fork gets the captured bytes it refers to.
      copyFileHistory(store, forked)
      switchTo(session.resume(forked, a.model), "fork")
    },
    planRewind: (index) => {
      const { a, entry } = rewindEntry(index)
      const owner = session.host.fileRestoration
      return owner
        ? {
            owner: owner.label,
            enabled: true,
            restored: 0,
            removed: 0,
            conflicts: [],
            note: `File restoration is managed by ${owner.source}. The core will not restore files.`,
          }
        : (a.fileRewind?.plan(entry.id) ?? {
            owner: "core",
            enabled: false,
            restored: 0,
            removed: 0,
            conflicts: [],
            note: `Files will not be restored. ${FILE_REWIND_COVERAGE}`,
          })
    },
    pruneFileHistory: () => {
      idle("prune file history")
      idleFiles()
      if (!agent().fileRewind) throw new Error("this session has no file history")
      return agent().fileRewind!.prune()
    },
    rewind: async (index, options) => {
      idle("rewind the conversation")
      idleFiles()
      const { a, store, entry } = rewindEntry(index)
      const owner = session.host.fileRestoration
      const restore = options?.restoreFiles !== false
      const interrupted = a.fileRewind?.interrupted()
      if (interrupted) {
        // Never two restores: finish the started one, or give it up only once it cannot finish.
        const stuck = interrupted.conflicts.length > 0 || interrupted.failure !== undefined
        if (!stuck && (!restore || owner || interrupted.messageId !== entry.id))
          throw new Error(
            `Finish the interrupted core file restore first: rewind with files to the message it was started for${owner ? ` (unload ${owner.source} first; it would restore instead)` : ""}`,
          )
        if (interrupted.conflicts.length && restore) throw new FileRewindConflictError(interrupted.conflicts)
        if (stuck && restore && (owner || interrupted.messageId !== entry.id))
          throw new Error(
            `The interrupted core file restore failed (${interrupted.failure ?? "conflicts"}); retry it with files to the same message, or rewind the conversation only to abandon it`,
          )
        if (!restore) a.fileRewind!.abandon()
      }
      if (restore && owner) {
        await a.hold("file restore", async () => {
          await owner.restore(index)
          // Inputs queued during the hold belong to the discarded conversation; do not wake it.
          a.abort()
          store.append({ type: "checkout", target: entry.parentId })
          switchTo(session.resume(store, a.model), "resume")
        })
        return
      } else if (restore && a.fileRewind?.plan(entry.id).enabled) {
        a.fileRewind.restore(entry.id, entry.parentId)
        switchTo(session.resume(store, a.model), "resume")
        return
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
          enabled: !disabled && agent().toolRestriction(tool) === undefined,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    setToolEnabled: (name, enabled) => {
      const tool = tools.list().find((entry) => entry.tool.name === name)?.tool
      if (!tool) throw new Error(`no tool named "${name}"`)
      const restriction = agent().toolRestriction(tool)
      if (enabled && restriction) throw new Error(`cannot enable "${name}": ${restriction}`)
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
    extensionAdmin: createExtensionAdmin({ cwd, ...(opts.home ? { home: opts.home } : {}) }),
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
    artifacts: {
      usage: () => {
        const a = agent()
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
        idle("prune artifacts")
        return agent().pruneArtifacts(scope)
      },
    },
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
