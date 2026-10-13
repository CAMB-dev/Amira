import { expect, test } from "bun:test"
import type { CommandContext, Extension, UiControl, ViewDefinition } from "@amira/api"
import { setup, waitFor } from "./app-harness.ts"

for (const mode of ["inline", "fullscreen"] as const) {
  for (const placement of ["dock", "fullscreen"] as const) {
    test(`${mode}: reload closes the ${placement} before unregistering and mounts a fresh instance`, async () => {
      const calls: string[] = []
      const controls: UiControl[] = []
      let command!: CommandContext
      let registeredAtClose = false
      const extension =
        (instance: number): Extension =>
        (api) => {
          api.onUnload(() => {
            expect(s.host.views.get("reload-view")).toBeDefined()
            calls.push(`unload ${instance}`)
          })
          api.registerView({
            kind: "reload-view",
            title: () => `Instance ${instance}`,
            render: () => [],
            onOpen: (_data, control) => {
              controls.push(control)
              calls.push(`open ${instance}`)
            },
            onClose: () => {
              registeredAtClose = s.host.views.get("reload-view") !== undefined
              calls.push(`close ${instance}`)
            },
          })
          api.registerCommand({
            name: "view",
            description: "Open the test view",
            run: (_args, ctx) => {
              command = ctx
              ctx.openView!({ kind: "reload-view", placement })
            },
          })
        }
      const s = await setup([], {
        settings: { mode },
        extensions: [extension(1)],
        commands: [{ name: "reload", description: "", run: () => s.host.unloadAll() }],
      })
      try {
        s.terminal.send("/view\r")
        await waitFor(() => s.live().includes("Instance 1"), "first instance mounted")
        expect((await s.commands!.run("/reload", { frontend: "tui" })).ok).toBe(true)
        expect(calls).toEqual(["open 1", "close 1", "unload 1"])
        expect(registeredAtClose).toBe(true)
        await waitFor(() => !s.live().includes("Instance 1"), "old view removed")
        controls[0]!.close()
        expect(command.openView!({ kind: "reload-view", placement })).toBe(false)
        expect(calls).toEqual(["open 1", "close 1", "unload 1"])
        await s.host.load(extension(2), "test-ext-0")
        s.terminal.send("/view\r")
        await waitFor(() => s.live().includes("Instance 2"), "new instance mounted")
        expect(controls[1]).not.toBe(controls[0])
        expect(calls).toEqual(["open 1", "close 1", "unload 1", "open 2"])
        command.quit()
        await s.exited
        await s.host.runExitHandlers()
        expect(calls).toEqual(["open 1", "close 1", "unload 1", "open 2", "close 2", "unload 2"])
      } finally {
        s.terminal.send("\x03\x03\x03")
        await s.exited
      }
    })
  }
}

for (const entry of ["command", "skill", "input"] as const) {
  test(`${entry}: views belong to the opening instance even with another extension's definition`, async () => {
    const calls: string[] = []
    const contexts: CommandContext[] = []
    const controls: UiControl[] = []
    const provider: Extension = (api) => {
      const definition: ViewDefinition = {
        kind: "shared",
        title: () => "Shared view",
        render: () => [],
        onOpen: (_data, control) => {
          controls.push(control)
          calls.push("open")
        },
        onClose: () => calls.push("close"),
      }
      api.registerView(definition)
    }
    const opener =
      (name: string): Extension =>
      (api) => {
        const run = (_text: string, ctx: CommandContext) => {
          contexts.push(ctx)
          ctx.openView!({ kind: "shared", placement: "dock" })
        }
        if (entry === "command") api.registerCommand({ name, description: "", run })
        if (entry === "skill") api.registerSkill({ name, description: "", run })
        if (entry === "input") api.registerInputHandler({ name, claims: (text) => text === name, run })
      }
    const s = await setup([], { extensions: [provider, opener("first"), opener("second")] })
    const send = (name: string) =>
      s.terminal.send(`${entry === "command" ? "/" : entry === "skill" ? "$" : ""}${name}\r`)
    try {
      send("first")
      await waitFor(() => calls.length === 1, "first opener")
      send("second")
      await waitFor(() => calls.length === 3, "different opener gets fresh viewer")
      expect(calls).toEqual(["open", "close", "open"])
      expect(controls[0]).not.toBe(controls[1])
      s.host.unload("test-ext-1")
      expect(calls).toHaveLength(3)
      expect(contexts[0]!.openView!({ kind: "shared", placement: "dock" })).toBe(false)
      s.host.unload("test-ext-2")
      expect(calls).toEqual(["open", "close", "open", "close"])
      expect(s.host.views.get("shared")).toBeDefined()
      await waitFor(() => !s.live().includes("Shared view"), "opening extension's dock removed")
    } finally {
      s.terminal.send("\x03\x03\x03")
      await s.exited
    }
  })
}

for (const action of ["unregister", "unload"] as const) {
  test(`provider ${action} closes both dock and fullscreen before removing the definition`, async () => {
    const calls: string[] = []
    let off!: () => void
    let command!: CommandContext
    let reopen: boolean | undefined
    const s = await setup([], {
      extensions: [
        (api) => {
          off = api.registerView({
            kind: "provider",
            title: () => "Provider view",
            render: () => [],
            onClose: (data) => {
              expect(s.host.views.get("provider")).toBeDefined()
              calls.push(String(data))
              reopen = command.openView!({ kind: "provider" })
            },
          })
        },
        (api) => {
          api.registerCommand({
            name: "both",
            description: "",
            run: (_args, ctx) => {
              command = ctx
              ctx.openView!({ kind: "provider", placement: "dock", data: "dock" })
              ctx.openView!({ kind: "provider", data: "fullscreen" })
            },
          })
        },
      ],
    })
    try {
      s.terminal.send("/both\r")
      await waitFor(() => s.live().includes("Provider view"), "provider views mounted")
      if (action === "unregister") off()
      else s.host.unload("test-ext-0")
      expect(calls).toEqual(["dock", "fullscreen"])
      expect(reopen).toBe(false)
      expect(s.host.views.get("provider")).toBeUndefined()
      off()
      expect(calls).toHaveLength(2)
      await waitFor(() => !s.live().includes("Provider view"), "both provider views removed")
    } finally {
      s.terminal.send("\x03\x03\x03")
      await s.exited
    }
  })
}
