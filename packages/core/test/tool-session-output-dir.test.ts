import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { History } from "../src/agent/history.ts"
import { setupToolSession } from "../src/agent/setup.ts"
import { ArtifactStore, artifactDir } from "../src/artifacts.ts"
import { SessionStore } from "../src/session-store.ts"
import { ToolRegistry } from "../src/tool-registry.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "amira-tool-session-output-dir-"))
  dirs.push(dir)
  return dir
}

function persistedSession(root: string) {
  const session = SessionStore.create({ cwd: root, dir: path.join(root, "sessions") })
  session.appendDisplay({ type: "display", text: "persist", level: "info" })
  return session
}

function toolSession(artifacts: ArtifactStore, session?: SessionStore) {
  return setupToolSession({
    assertActive: () => {},
    sessionId: artifacts.sessionId,
    tools: new ToolRegistry(),
    loadedTools: new Set(),
    allowsTool: () => true,
    session,
    history: new History(
      {
        session,
        reportStoreError: (error) => {
          throw new Error(error)
        },
        originals: undefined,
      },
      { messages: [] },
    ),
    artifacts,
    contextHas: () => false,
    depth: 0,
    maxDepth: () => 1,
    model: () => {
      throw new Error("This fixture does not resolve a model")
    },
    spawning: undefined,
    expectNotice: undefined,
  })
}

test("a persisted tool session exposes the exact artifact directory", () => {
  const root = tempDir()
  const session = persistedSession(root)
  const dir = artifactDir(session.file, session.id)
  const artifacts = new ArtifactStore({ dir, storageRoot: path.dirname(session.file), sessionId: session.id })
  const tools = toolSession(artifacts, session)

  expect(artifacts.writableDir).toBe(dir)
  expect(tools.outputDir).toBe(dir)
  expect(tools.outputs?.limits).toBe(artifacts.limits)
  expect(tools.outputDir).not.toBe(tools.dir)
  expect(existsSync(dir)).toBe(false)
})

test("a no-file tool session does not expose its writable artifact directory", () => {
  const root = tempDir()
  const dir = path.join(root, "outputs")
  const artifacts = new ArtifactStore({ dir, storageRoot: root, sessionId: "no-file" })
  const tools = toolSession(artifacts)

  expect(artifacts.writableDir).toBe(dir)
  expect(tools.outputDir).toBeUndefined()
  expect("outputDir" in tools).toBe(false)
  expect(tools.outputs?.limits).toBe(artifacts.limits)
  expect(existsSync(dir)).toBe(false)
})

for (const persisted of [false, true]) {
  for (const inherited of [false, true]) {
    test(`a private ${persisted ? "persisted" : "no-file"} tool session has no output directory ${inherited ? "with" : "without"} inherited outputs`, async () => {
      const root = tempDir()
      const session = persisted ? persistedSession(root) : undefined
      const parent = inherited
        ? new ArtifactStore({ dir: path.join(root, "parent"), storageRoot: root, sessionId: "parent" })
        : undefined
      const saved = await parent?.save({ text: "inherited output", tool: "fixture" })
      const dir = path.join(root, "private", "outputs")
      const artifacts = new ArtifactStore({
        dir,
        storageRoot: root,
        sessionId: session?.id ?? "private",
        readOnly: true,
        ...(parent ? { parent } : {}),
      })
      const tools = toolSession(artifacts, session)

      expect(artifacts.writableDir).toBeUndefined()
      expect(tools.outputDir).toBeUndefined()
      expect("outputDir" in tools).toBe(false)
      expect(tools.outputs?.limits).toBe(artifacts.limits)
      if (saved) expect(tools.outputs?.find(saved.id)).toEqual(saved)
      await expect(tools.outputs!.save({ text: "not allowed", tool: "fixture" })).rejects.toThrow(
        "Private sessions cannot save output files",
      )
      expect(existsSync(dir)).toBe(false)
    })
  }
}

test("a writable child exposes its own artifact directory, not its parent's", () => {
  const root = tempDir()
  const session = persistedSession(root)
  const parent = new ArtifactStore({ dir: path.join(root, "parent"), storageRoot: root, sessionId: "parent" })
  const dir = artifactDir(session.file, session.id)
  const artifacts = new ArtifactStore({
    dir,
    storageRoot: path.dirname(session.file),
    sessionId: session.id,
    parent,
  })
  const tools = toolSession(artifacts, session)

  expect(tools.outputDir).toBe(dir)
  expect(tools.outputDir).not.toBe(parent.writableDir)
})
