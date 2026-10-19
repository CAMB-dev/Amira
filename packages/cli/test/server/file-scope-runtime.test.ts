import "./offline.ts"
import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { OwnedConversation } from "@amira/api"
import { agentSessionOwner } from "../../../core/src/session-routing.ts"
import { createWorkspaceRuntime } from "../../src/server/runtime.ts"

test("workspace startup pins the file root before the first remote file request", async () => {
  const root = await mkdtemp(join(tmpdir(), "amira-file-scope-runtime-"))
  const cwd = join(root, "workspace")
  const outside = join(root, "outside")
  await mkdir(cwd)
  await mkdir(outside)
  await writeFile(join(outside, "private.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const runtime = await createWorkspaceRuntime({
    cwd,
    ai: createAi({
      dialects: [createMockDialect([{ text: "unused" }])],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }),
    model: "mock/test",
    autoTitle: false,
    builtins: async () => [],
  })
  try {
    await rename(cwd, `${cwd}.original`)
    await symlink(outside, cwd, process.platform === "win32" ? "junction" : "dir")
    const attachment = runtime.attach()
    await expect(attachment.request("images.read", { path: "private.png" })).rejects.toThrow("root changed")
    await expect(attachment.request("files.list", {})).rejects.toThrow("root changed")
    await expect(attachment.request("files.refresh", {})).rejects.toThrow("root changed")
  } finally {
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  }
})

for (const replace of ["beforeFocus", "afterFocus"] as const) {
  test(`native roots stay pinned from actor creation: replacement ${replace}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "amira-native-root-"))
    const cwd = join(root, "workspace")
    const native = join(root, "native")
    const outside = join(root, "outside")
    for (const dir of [cwd, native, outside]) await mkdir(dir)
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    await writeFile(join(native, "own.png"), png)
    await writeFile(join(outside, "private.png"), png)
    let owned!: OwnedConversation
    const runtime = await createWorkspaceRuntime({
      cwd,
      autoTitle: false,
      model: "mock/test",
      ai: createAi({
        dialects: [createMockDialect([])],
        providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      }),
      builtins: async () => [
        {
          source: "test:native",
          extension: async (api) => {
            owned = await api.conversations!.openOrCreate(
              { key: basename(root), name: "Native", cwd: native, systemPrompt: "", callableTools: [] },
              { askUser: async () => undefined },
            )
            api.registerCommand({
              name: "focus",
              description: "fixture",
              run: (_args, ctx) => {
                ctx.focusConversation?.(owned)
              },
            })
          },
        },
      ],
    })
    const port = runtime.attach()
    try {
      expect(owned).toBeDefined()
      if (replace === "afterFocus") {
        expect(await port.execute("command.run", { line: "/focus" })).toMatchObject({ ok: true })
        expect(await port.request("images.read", { scope: owned.id, path: "own.png" })).toMatchObject({
          name: "own.png",
        })
      }
      await rename(native, `${native}.original`)
      await symlink(outside, native, process.platform === "win32" ? "junction" : "dir")
      if (replace === "beforeFocus") {
        expect(await port.execute("command.run", { line: "/focus" })).toMatchObject({
          ok: false,
          error: expect.stringContaining("root changed"),
        })
        expect((await port.request("conversations.list", {})).conversations).toEqual([])
      } else {
        await expect(port.request("images.read", { scope: owned.id, path: "private.png" })).rejects.toThrow(
          "root changed",
        )
        await expect(port.request("files.list", { scope: owned.id })).rejects.toThrow("root changed")
      }
    } finally {
      await runtime.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("public child root is pinned at creation, before its first frontend file request", async () => {
  const root = await mkdtemp(join(tmpdir(), "amira-child-root-"))
  const cwd = join(root, "workspace")
  const childCwd = join(root, "child")
  const outside = join(root, "outside")
  for (const dir of [cwd, childCwd, outside]) await mkdir(dir)
  await writeFile(join(outside, "private.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const gate = Promise.withResolvers<void>()
  const runtime = await createWorkspaceRuntime({
    cwd,
    autoTitle: false,
    model: "mock/test",
    ai: createAi({
      dialects: [createMockDialect([{ text: "blocked child", hold: { chunks: 0, until: gate.promise } }])],
      providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
    }),
    builtins: async () => [],
  })
  const port = runtime.attach()
  const agent = agentSessionOwner(port.snapshot.state.sessionId)!
  const child = agent.tree!.createGroup(agent, { name: "child" }).spawn({ cwd: childCwd, prompt: "hold" })
  try {
    const deadline = Date.now() + 3000
    while (!agentSessionOwner(child.id) && Date.now() < deadline) await Bun.sleep(1)
    expect(agentSessionOwner(child.id)).toBeDefined()
    await rename(childCwd, `${childCwd}.original`)
    await symlink(outside, childCwd, process.platform === "win32" ? "junction" : "dir")
    await expect(port.request("images.read", { scope: child.id, path: "private.png" })).rejects.toThrow(
      "root changed",
    )
    await expect(port.request("files.list", { scope: child.id })).rejects.toThrow("root changed")
  } finally {
    gate.resolve()
    await child.result()
    await runtime.stop()
    await rm(root, { recursive: true, force: true })
  }
})
