import type { SessionControl, ShellMode } from "@amira/api"
import { toolTraits } from "@amira/core"
import type { ControlContext } from "./context.ts"

type ToolControl = Pick<SessionControl, "permissions" | "tools" | "setToolEnabled" | "setShell">

export function createToolControl(ctx: ControlContext): ToolControl {
  return {
    permissions: () => {
      const p = ctx.agent().permissions
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
    tools: () =>
      ctx.tools
        .list()
        .map(({ tool, source, disabled }) => ({
          name: tool.name,
          description: tool.description,
          source,
          exposure: tool.exposure ?? "active",
          ...(toolTraits(tool) ? { traits: toolTraits(tool) } : {}),
          enabled: !disabled && ctx.agent().toolRestriction(tool) === undefined,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    setToolEnabled: (name, enabled) => {
      const tool = ctx.tools.list().find((entry) => entry.tool.name === name)?.tool
      if (!tool) throw new Error(`no tool named "${name}"`)
      const restriction = ctx.agent().toolRestriction(tool)
      if (enabled && restriction) throw new Error(`cannot enable "${name}": ${restriction}`)
      ;(enabled ? ctx.turnedOn : ctx.turnedOff).add(name)
      ;(enabled ? ctx.turnedOff : ctx.turnedOn).delete(name)
      ctx.applyDisabled()
    },
    setShell: (mode: ShellMode) => {
      if (mode !== "auto" && mode !== "bash" && mode !== "powershell") {
        throw new Error(`shell must be auto, bash or powershell, got "${mode}"`)
      }
      if (mode === "powershell" && ctx.platform !== "win32") {
        throw new Error("the powershell tool is only available on Windows")
      }
      ctx.shell.set(mode)
      // The shell mode decides these two again, over earlier /tools choices.
      for (const { tool } of ctx.tools.list()) {
        if (!toolTraits(tool)?.shell) continue
        ctx.turnedOn.delete(tool.name)
        ctx.turnedOff.delete(tool.name)
      }
      ctx.applyDisabled()
    },
  }
}
