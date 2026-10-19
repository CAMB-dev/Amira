import "./offline.ts"
import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServerFileOperations } from "../../src/server/files.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "amira-files-"))
  roots.push(root)
  await mkdir(join(root, "project"))
  return { root, cwd: join(root, "project") }
}

test("pages a bounded immutable listing and invalidates cursors on refresh", async () => {
  const { cwd } = await workspace()
  const service = createServerFileOperations({
    generation: () => 1,
    resolveScope: () => ({ cwd }),
    maxFiles: 3,
    stream: async (_cwd, emit) => {
      emit(["a.ts", "b.ts", "c.ts", "d.ts"])
      return true
    },
  })
  service.establishScope(cwd)
  const first = await service["files.list"]({ limit: 2 })
  expect(first.entries).toEqual(["a.ts", "b.ts"])
  expect(first.partial).toBe(true)
  const next = await service["files.list"]({ cursor: first.nextCursor, limit: 2 })
  expect(next.entries).toEqual(["c.ts"])
  expect(next.generation).toBe(first.generation)
  expect(await service["files.list"]({ cursor: first.nextCursor, limit: 2 })).toEqual(next)
  const refreshed = await service["files.refresh"]({ limit: 2 })
  expect(refreshed.generation).not.toBe(first.generation)
  await expect(service["files.list"]({ cursor: first.nextCursor })).rejects.toMatchObject({
    code: "stale_operation",
  })
  service.dispose()
})

test("cancels a pending listing before its generation has been delivered", async () => {
  const { cwd } = await workspace()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const service = createServerFileOperations({
    generation: () => 1,
    resolveScope: () => ({ cwd }),
    stream: async (_cwd, _emit, { signal }) => {
      started()
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      return false
    },
  })
  service.establishScope(cwd)
  const abort = new AbortController()
  const pending = service["files.list"]({}, { signal: abort.signal }).catch((error) => error)
  await ready
  abort.abort()
  expect(await pending).toMatchObject({ code: "cancelled" })
  service.dispose()
})

test("image and artifact reads authorize canonical scope, not paths or symlink aliases", async () => {
  const { root, cwd } = await workspace()
  const outside = join(root, "outside")
  const artifacts = join(root, "owned-artifacts")
  await mkdir(outside)
  await mkdir(artifacts)
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  await writeFile(join(cwd, "画.png"), png)
  await writeFile(join(cwd, "fake.png"), "not an image")
  await writeFile(join(outside, "private.png"), png)
  await writeFile(join(artifacts, "output.txt"), "owned output")
  await symlink(outside, join(cwd, "link"), process.platform === "win32" ? "junction" : "dir")
  const service = createServerFileOperations({
    generation: () => 1,
    resolveScope: (scope) => (scope === undefined ? { cwd } : undefined),
    resolveArtifact: (id) => ({
      path: id === "owned" ? join(artifacts, "output.txt") : join(outside, "private.png"),
      root: artifacts,
    }),
  })
  service.establishScope(cwd)
  try {
    expect(await service["images.read"]({ path: "画.png" })).toEqual({
      name: "画.png",
      mimeType: "image/png",
      data: png.toString("base64"),
      bytes: png.length,
    })
    await expect(service["images.read"]({ path: "../outside/private.png" })).rejects.toThrow("outside")
    await expect(service["images.read"]({ path: "link/private.png" })).rejects.toThrow("outside")
    await expect(service["images.read"]({ path: "fake.png" })).rejects.toThrow("MIME")
    await expect(service["images.read"]({ scope: "foreign-child", path: "画.png" })).rejects.toThrow("scope")
    expect(Buffer.from((await service["artifacts.read"]({ id: "owned" })).data, "base64").toString()).toBe(
      "owned output",
    )
    await expect(service["artifacts.read"]({ id: "foreign" })).rejects.toThrow("outside")
  } finally {
    service.dispose()
  }
})

for (const scope of [undefined, "native-child"]) {
  for (const replacement of ["junction", "directory"]) {
    test(`rejects ${replacement} replacement of an established ${scope ?? "workspace"} scope before its first operation`, async () => {
      const { root, cwd } = await workspace()
      const outside = join(root, "outside")
      await mkdir(outside)
      await writeFile(join(outside, "private.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      let streams = 0
      const service = createServerFileOperations({
        generation: () => 1,
        resolveScope: () => ({ cwd }),
        stream: async (dir, emit) => {
          streams++
          emit(await readdir(dir))
          return true
        },
      })
      const params = scope === undefined ? {} : { scope }
      try {
        service.establishScope(cwd, scope)
        await rename(cwd, `${cwd}.original`)
        if (replacement === "junction")
          await symlink(outside, cwd, process.platform === "win32" ? "junction" : "dir")
        else {
          await mkdir(cwd)
          await writeFile(join(cwd, "private.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        }
        await expect(service["images.read"]({ ...params, path: "private.png" })).rejects.toThrow(
          "root changed",
        )
        await expect(service["files.list"](params)).rejects.toThrow("root changed")
        await expect(service["files.refresh"](params)).rejects.toThrow("root changed")
        expect(streams).toBe(0)
        expect(() => service.establishScope(cwd, scope)).toThrow("root changed")
      } finally {
        service.dispose()
      }
    })
  }
}

test("does not establish authority lazily on a file operation", async () => {
  const { cwd } = await workspace()
  const service = createServerFileOperations({ generation: () => 1, resolveScope: () => ({ cwd }) })
  try {
    await expect(service["images.read"]({ path: "private.png" })).rejects.toThrow("not been established")
    await expect(service["files.list"]({})).rejects.toThrow("not been established")
  } finally {
    service.dispose()
  }
})

test("rejects a root replaced while a listing is being built", async () => {
  const { root, cwd } = await workspace()
  const outside = join(root, "outside")
  await mkdir(outside)
  const service = createServerFileOperations({
    generation: () => 1,
    resolveScope: () => ({ cwd }),
    stream: async (_cwd, emit) => {
      await rename(cwd, `${cwd}.original`)
      await symlink(outside, cwd, process.platform === "win32" ? "junction" : "dir")
      emit(["private.png"])
      return true
    },
  })
  service.establishScope(cwd)
  try {
    await expect(service["files.list"]({})).rejects.toThrow("root changed")
  } finally {
    service.dispose()
  }
})

test("slow scoped reads cannot return after selection changes", async () => {
  const { cwd } = await workspace()
  let generation = 1
  let release!: () => void
  const service = createServerFileOperations({
    generation: () => generation,
    resolveScope: async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { cwd }
    },
  })
  service.establishScope(cwd)
  const pending = service["images.read"]({ path: "missing.png" }).catch((error) => error)
  generation++
  release()
  expect(await pending).toMatchObject({ code: "stale_session" })
  service.dispose()
})
