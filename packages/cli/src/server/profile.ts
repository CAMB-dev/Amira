import type { CommandCompleteContext, Extension } from "@amira/api"
import { defineExtension } from "@amira/api"
import agent from "../../../../extensions/agent/src/index.ts"
import autoTitle from "../../../../extensions/auto-title/src/index.ts"
import {
  builtinPresenters,
  builtinTools,
  registerJobs,
} from "../../../../extensions/builtin-tools/src/index.ts"
import { createMonitorTool } from "../../../../extensions/builtin-tools/src/monitor.ts"
import { availableShellTools } from "../../../../extensions/builtin-tools/src/shell.ts"
import { toolSearchExtension } from "../../../../extensions/builtin-tools/src/tool-search.ts"
import commands from "../../../../extensions/commands/src/index.ts"
import { safeProviderUrl } from "../../../../extensions/commands/src/provider-url.ts"
import mcp from "../../../../extensions/mcp/src/index.ts"
import skills from "../../../../extensions/skills/src/index.ts"
import status from "../../../../extensions/status/src/index.ts"
import web from "../../../../extensions/web/src/index.ts"

// No provider/package administration through a remote model-proxy frontend. Local theme,
// verbose and terminal controls are not registered here either.
const unsupportedCommands = new Set(["provider", "ext"])
function safeProviderContext<T extends CommandCompleteContext>(ctx: T): T {
  return {
    ...ctx,
    session: {
      ...ctx.session,
      providers: () =>
        ctx.session.providers().map((provider) => ({
          ...provider,
          baseUrl: safeProviderUrl(provider.baseUrl, { originOnly: true }),
        })),
    },
  }
}
const serverCommands: Extension = (api) =>
  commands({
    ...api,
    registerCommand: (command) => {
      if (unsupportedCommands.has(command.name)) return () => {}
      const complete = command.args?.complete
      return api.registerCommand({
        ...command,
        ...(complete
          ? {
              args: {
                ...command.args,
                complete: (prefix, ctx) => complete(prefix, safeProviderContext(ctx)),
              },
            }
          : {}),
        run: (args, ctx) => command.run(args, safeProviderContext(ctx)),
      })
    },
  })

// Reuse execution exports without invoking the local builtin initializer's warmup timer.
const tools = defineExtension(async (api) => {
  const shell = () => api.session()?.info().shell ?? api.settings.shell
  for (const tool of await availableShellTools(builtinTools, shell)) {
    api.registerTool(tool.name === "monitor" ? createMonitorTool(undefined, {}, shell) : tool)
  }
  for (const [name, presenter] of Object.entries(builtinPresenters)) api.registerToolRenderer(name, presenter)
  registerJobs(api)
})

/** Bundled execution and semantic status only. No terminal-status, themes or third-party code. */
export async function serverBuiltins(): Promise<{ source: string; extension: Extension }[]> {
  return [
    { source: "builtin:tools", extension: tools },
    { source: "builtin:tool-search", extension: toolSearchExtension },
    { source: "builtin:status", extension: status },
    { source: "builtin:commands", extension: serverCommands },
    { source: "builtin:auto-title", extension: autoTitle },
    { source: "builtin:skills", extension: skills },
    { source: "builtin:mcp", extension: mcp },
    { source: "builtin:web", extension: web },
    { source: "builtin:agent", extension: agent },
  ]
}
