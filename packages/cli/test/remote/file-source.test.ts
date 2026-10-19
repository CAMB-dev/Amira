import "../server/offline.ts"
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { waitFor } from "../../../tui/test/app-harness.ts"
import { createRemoteFileSource, type RemoteFileClient } from "../../src/remote/file-source.ts"
import { createServerFileOperations } from "../../src/server/files.ts"

test("remote file source pages Linux-relative Unicode paths and retains partial flags", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "amira-remote-files-"))
  const handlers = createServerFileOperations({
    generation: () => 1,
    resolveScope: () => ({ cwd }),
    maxFiles: 120,
    stream: async (_cwd, emit) => {
      emit(Array.from({ length: 121 }, (_, n) => `工作:tree/file-${n}.ts`))
      return false
    },
  })
  handlers.establishScope(cwd)
  const calls: string[] = []
  const client: RemoteFileClient = {
    sessionGeneration: 1,
    async request(operation, params, options) {
      calls.push(operation)
      return handlers[operation](params as never, options) as never
    },
  }
  const source = createRemoteFileSource(client)
  try {
    const listing = source.listing()
    await waitFor(() => listing.done, "remote listing")
    expect(listing.files).toBe(120)
    expect(listing.partial).toBe(true)
    expect(listing.entries).toContain("工作:tree/")
    expect(calls).toEqual(["files.refresh", "files.list"])
  } finally {
    source.dispose?.()
    handlers.dispose()
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("a stale file result cannot populate a new session's picker", async () => {
  let finish!: (page: { generation: string; entries: string[]; partial: boolean }) => void
  let generation = 1
  const client: RemoteFileClient = {
    get sessionGeneration() {
      return generation
    },
    request: async () =>
      new Promise((resolve) => {
        finish = resolve as typeof finish
      }),
  }
  const source = createRemoteFileSource(client)
  try {
    const listing = source.listing()
    generation++
    finish({ generation: "old", entries: ["must-not-appear.ts"], partial: false })
    await waitFor(() => listing.done, "stale listing settlement")
    expect(listing.entries).toEqual([])
    expect(listing.partial).toBe(true)
  } finally {
    source.dispose?.()
  }
})

test("a failed remote listing is partial, never falsely complete", async () => {
  const source = createRemoteFileSource({
    sessionGeneration: 1,
    request: async () => {
      throw new Error("fixture read failure")
    },
  })
  try {
    const listing = source.listing()
    await waitFor(() => listing.done, "failed listing settlement")
    expect(listing.partial).toBe(true)
    expect(listing.entries).toEqual([])
  } finally {
    source.dispose?.()
  }
})
