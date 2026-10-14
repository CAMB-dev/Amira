import { statSync } from "node:fs"
import path from "node:path"
import type { SessionControl } from "@amira/api"
import {
  copyFileHistory,
  deleteSession as deleteStoredSession,
  findSession,
  listSessions,
  SessionStore,
  sessionsDir,
  storedHistory,
  subagentsOf,
} from "@amira/core"
import {
  sessionDeletionDirectory,
  sessionTraceCleanupProof,
  withSessionDeletionDirectory,
} from "../../../core/src/session-delete.ts"
import type { ControlContext } from "./context.ts"

type SessionsControl = Pick<
  SessionControl,
  "newSession" | "sessions" | "readSession" | "resume" | "rename" | "deleteSession" | "fork"
>

export function createSessionsControl(ctx: ControlContext): SessionsControl {
  return {
    newSession: (options) =>
      ctx.select(options?.signal, async (signal) => {
        ctx.idle("start a new session")
        const store = SessionStore.create({ cwd: ctx.cwd, dir: ctx.directory() })
        await ctx.switchTo(
          store.id,
          (acquired) => ctx.session.resume(store, ctx.agent().model, acquired, { signal }),
          "clear",
          signal,
        )
      }),
    sessions: () =>
      listSessions(ctx.cwd, ctx.directory()).map((s) => ({
        id: s.id,
        updatedAt: s.updatedAt,
        firstUserText: s.firstUserText,
        ...(s.title ? { title: s.title } : {}),
        searchText: s.searchText,
        messageCount: s.messageCount,
      })),
    readSession: (id) => {
      // The current session from memory: its file may lag behind (or have stopped saving).
      const live = id === ctx.agent().sessionId ? ctx.agent().session : undefined
      let store: SessionStore
      let updatedAt: number
      try {
        const file = live?.file ?? findSession(ctx.cwd, id, ctx.directory())
        if (!file) return undefined
        store = live ?? SessionStore.open(file)
        updatedAt = live ? Date.now() : statSync(file).mtimeMs
      } catch {
        return undefined
      }
      const createdAt = Date.parse(store.header.createdAt)
      const entries = subagentsOf(store.id, store, ctx.session.tree)
      return {
        id: store.id,
        cwd: store.header.cwd,
        createdAt: Number.isFinite(createdAt) ? createdAt : updatedAt,
        updatedAt,
        messages: storedHistory(store),
        subagents: entries.map((e) => e.info),
        subagentMessages: (childId: string) => entries.find((e) => e.info.id === childId)?.history(),
      }
    },
    resume: (id, options) =>
      ctx.select(options?.signal, async (signal) => {
        ctx.idle("resume another session")
        if (id === ctx.agent().sessionId) throw new Error(`already in session ${id}`)
        const file = findSession(ctx.cwd, id, ctx.directory())
        if (!file) throw new Error(`no session ${id} in ${ctx.cwd}`)
        const store = SessionStore.open(file)
        await ctx.switchTo(
          store.id,
          (acquired) => ctx.session.resume(store, ctx.agent().model, acquired, { signal }),
          "resume",
          signal,
        )
      }),
    rename: (title, options) => {
      const a = ctx.agent()
      if (options?.sessionId && options.sessionId !== a.sessionId) return
      if (!a.session) throw new Error("this session is not stored")
      if (!a.session.rename(title, options?.source ?? "manual")) return
      a.bus.emit("session.title", { title: a.session.title ?? "" }, { sessionId: a.sessionId })
    },
    deleteSession: async (id) => {
      ctx.idle("delete a session")
      const proof = sessionDeletionDirectory(ctx.directory() ?? sessionsDir(ctx.cwd), true)
      const files = deleteStoredSession(ctx.cwd, id, ctx.agent().sessionId, ctx.directory())
      if (ctx.trace) {
        const traceProof = sessionTraceCleanupProof(proof, files)
        await ctx.trace.forget(files.map((file) => path.basename(file, ".jsonl")))
        // Retire and drain in-flight appends before staging cleanup in the verified private root.
        traceProof.check()
        withSessionDeletionDirectory(proof, (directory, stage) => {
          traceProof.checkMoved(directory)
          for (const file of files) {
            stage(path.join(directory, path.relative(proof.directory, `${file}.trace.jsonl`)))
          }
        })
      }
    },
    fork: (index, options) =>
      ctx.select(options?.signal, async (signal) => {
        ctx.idle("fork the conversation")
        const a = ctx.agent()
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
        await ctx.switchTo(
          forked.id,
          (acquired) => ctx.session.resume(forked, a.model, acquired, { signal }),
          "fork",
          signal,
        )
      }),
  }
}
