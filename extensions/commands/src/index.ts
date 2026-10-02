import { type CommandDefinition, defineExtension, type ExtensionAPI } from "@amira/api"
import { compactCommand, contextCommand, pruneCommand } from "./context-commands.ts"
import { costCommand } from "./cost-command.ts"
import { extensionCommand } from "./ext-command.ts"
import { helpCommand } from "./help-command.ts"
import { modelCommand } from "./model-command.ts"
import { permissionsCommand } from "./permissions-command.ts"
import { providerCommand } from "./provider-command.ts"
import { quitCommand } from "./quit-command.ts"
import { reloadCommand } from "./reload-command.ts"
import { registerRewindCommands } from "./rewind-command.ts"
import { clearCommand, forkCommand, renameCommand, resumeCommand } from "./sessions-commands.ts"
import { shellCommand } from "./shell-command.ts"
import { statusCommand } from "./status-command.ts"
import { thinkingCommand } from "./thinking-command.ts"
import { toolsCommand } from "./tools-command.ts"

export { extensionCommand } from "./ext-command.ts"
export {
  cacheHitRate,
  contextReport,
  costByModel,
  costReport,
  estimateTokens,
  formatCost,
  formatTokens,
  table,
  tokensPerSecond,
} from "./format.ts"
export { reloadSummary } from "./reload-command.ts"
export { ago, sessionLabel } from "./sessions-commands.ts"

/**
 * The built-in slash commands (D55), registered through the same API as any extension's (D27).
 * They act on the session through `ctx.session`, which the host provides.
 */
export default defineExtension((api: ExtensionAPI) => {
  registerRewindCommands(api)

  // /status installs its event tracking before the extension command registers its panel.
  const status = statusCommand(api)
  const add = (command: CommandDefinition) => api.registerCommand(command)
  const extensions = extensionCommand(api)
  add(extensions.command)

  add(helpCommand())
  add(quitCommand())
  add(clearCommand())
  add(modelCommand())
  add(thinkingCommand())
  add(status)
  add(compactCommand())
  add(renameCommand())
  add(forkCommand())
  add(resumeCommand())
  add(pruneCommand())
  add(shellCommand())
  add(permissionsCommand())
  add(toolsCommand())
  add(providerCommand())
  add(costCommand())
  add(contextCommand())
  add(reloadCommand(extensions.running))
})
