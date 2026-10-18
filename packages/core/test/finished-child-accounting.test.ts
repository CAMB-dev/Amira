import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAi, createMockDialect, emptyUsage } from "@amira/ai"
import { Agent } from "../src/agent.ts"
import { accountingDescendants } from "../src/owned-conversations-descendants.ts"
import { conversationUsage } from "../src/owned-conversations-usage.ts"
import { SessionStore } from "../src/session-store.ts"
import { subagentMessages, subagentsOf } from "../src/subagent-list.ts"
import { AgentTree } from "../src/subagents.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

for (const [fileState, replacementHeader] of [
  ["available", "createdAt"],
  ["unreadable", "createdAt"],
  ["missing", "createdAt"],
  ["unreadable", "id"],
  ["missing", "id"],
  ["unreadable", "parent"],
  ["missing", "parent"],
] as const) {
  test(`finished child retains its $2 receipt when its original session file is ${fileState} and replacement changes ${replacementHeader}`, async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "amira-finished-child-accounting-"))
    const opened = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const mock = createMockDialect([
      () => {
        opened.resolve()
        return {
          text: "TRANSCRIPT_SENTINEL",
          hold: { chunks: 0, until: release.promise },
          usage: { ...emptyUsage(), input: 1, output: 1, cost: 2 },
        }
      },
    ])
    const ai = createAi({
      dialects: [mock],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      retry: { retries: 0 },
    })
    const tree = new AgentTree({ ai, sections: () => [] })
    const store = SessionStore.create({ cwd: directory, dir: directory })
    const parent = new Agent({
      ai,
      tree,
      session: store,
      cwd: directory,
      model: ai.model("mock/test"),
      tools: new ToolRegistry(),
      sections: [],
    })
    try {
      const child = tree.spawn(parent, { prompt: "task" })
      await opened.promise
      const captured = tree.subagent(child.id)!.session!
      expect(readFileSync(captured.file, "utf8")).toContain("amira.accounting-requests")
      expect(conversationUsage(parent).total).toMatchObject({ knownCostUsd: 0, complete: false })
      if (fileState === "unreadable") {
        renameSync(captured.file, `${captured.file}.saved`)
        mkdirSync(captured.file)
      } else if (fileState === "missing") {
        const childDirectory = path.dirname(captured.file)
        renameSync(childDirectory, `${childDirectory}.saved`)
        writeFileSync(childDirectory, "not a directory")
      }
      release.resolve()
      await child.result()
      await tree.waitForChildren()
      expect(tree.usage.cost).toBe(2)
      expect(conversationUsage(captured).total).toMatchObject({
        knownCostUsd: 2,
        complete: fileState === "available",
      })
      const snapshot = conversationUsage(parent)
      expect(snapshot.total).toMatchObject({ knownCostUsd: 2, complete: fileState === "available" })
      expect(snapshot.descendants).toMatchObject([
        {
          sessionId: child.id,
          parentSessionId: store.id,
          usage: { knownCostUsd: 2, complete: fileState === "available" },
        },
      ])
      const finished = tree.subagent(child.id)!
      expect(finished.session).toBeUndefined()
      expect(finished.messages).toBeUndefined()
      expect(finished.file).toBe(captured.file)
      expect(Object.keys(finished).sort()).toEqual(["accountingDestination", "file", "info"])
      expect(finished.accountingDestination).toMatch(/^[a-f0-9]{64}$/)
      expect(finished.accountingDestination).not.toContain("TRANSCRIPT_SENTINEL")
      if (fileState !== "available") {
        const listed = subagentsOf(store.id, store, tree)[0]!
        expect(listed.session).toBeUndefined()
        expect(listed.messages()).toEqual([])
        expect(listed.history()).toEqual([])
        expect(JSON.stringify(snapshot)).not.toContain("TRANSCRIPT_SENTINEL")
        // Reusing the same pathname cannot redirect the original receipt cache.
        if (fileState === "unreadable") rmSync(captured.file, { recursive: true })
        else {
          rmSync(path.dirname(captured.file))
          mkdirSync(path.dirname(captured.file))
        }
        const replacement = SessionStore.create({
          cwd: directory,
          dir: path.dirname(captured.file),
          id: replacementHeader === "id" ? "unrelated-child" : child.id,
          parent: replacementHeader === "parent" ? "unrelated-parent" : store.id,
        })
        replacement.appendMessage({
          role: "user",
          content: [{ type: "text", text: "FOREIGN_TRANSCRIPT_SENTINEL" }],
        })
        replacement.append({
          type: "side_usage",
          model: { provider: "mock", model: "test" },
          usage: { ...emptyUsage(), cost: 9 },
        })
        expect(replacement.header.createdAt).not.toBe(captured.header.createdAt)
        expect(conversationUsage(replacement).total.knownCostUsd).toBe(9)
        const foreign = SessionStore.create({
          cwd: directory,
          dir: path.join(path.dirname(replacement.file), "subagents"),
          id: "foreign-leaf",
          parent: replacement.id,
        })
        foreign.append({
          type: "side_usage",
          model: { provider: "mock", model: "test" },
          usage: { ...emptyUsage(), cost: 5 },
        })
        replacement.append({ type: "subagent", childSessionId: foreign.id, role: "agent" })
        if (replacement.file !== captured.file) renameSync(replacement.file, captured.file)
        const recovered = conversationUsage(parent)
        expect(recovered.total).toMatchObject({ knownCostUsd: 2, complete: false })
        expect(recovered.descendants).toMatchObject([
          {
            sessionId: child.id,
            parentSessionId: store.id,
            usage: { knownCostUsd: 2, complete: false },
          },
        ])
        expect(recovered.descendants).toHaveLength(1)
        expect(JSON.stringify(recovered)).not.toContain("FOREIGN_TRANSCRIPT_SENTINEL")
        {
          const listing = subagentsOf(store.id, store, tree)
          expect(listing).toHaveLength(1)
          expect(listing[0]!.session).toBeUndefined()
          expect(listing[0]!.accountingDestination).toBe(finished.accountingDestination)
          expect(listing[0]!.messages()).toEqual([])
          expect(listing[0]!.history()).toEqual([])
          expect(subagentMessages(parent, tree, child.id)).toEqual([])
          const traversal = accountingDescendants(store.id, store, tree)
          expect(traversal.entries).toHaveLength(1)
          expect(traversal.entries[0]!.session).toBeUndefined()
          expect(
            traversal.requirements.some(
              (requirement) => requirement.kind === "reference" && !requirement.verified,
            ),
          ).toBe(true)
        }
      }
    } finally {
      release.resolve()
      await parent.dispose()
      await tree.waitForChildren()
      tree.releaseScope()
      rmSync(directory, { recursive: true, force: true })
    }
  })
}
