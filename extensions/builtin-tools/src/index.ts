import { defineExtension, hostWarmUpCommands } from "@amira/api"
import { applyPatchTool } from "./apply-patch.ts"
import { askUserPresenter, askUserTool } from "./ask-user.ts"
import { bashTool, powershellTool } from "./bash.ts"
import { editTool } from "./edit.ts"
import { globTool } from "./glob.ts"
import { grepTool } from "./grep.ts"
import { jobListTool, jobOutputTool, jobStopTool, jobTools } from "./jobs.ts"
import { registerJobs } from "./jobs-ui.ts"
import { outputReadTool } from "./output-read.ts"
import { builtinPresenters } from "./presenters.ts"
import { readTool } from "./read.ts"
import { availableShellTools, warmUpShell } from "./shell.ts"
import { toolSearchExtension, toolSearchTool } from "./tool-search.ts"
import { writeTool } from "./write.ts"

export { configureJobs, jobsConfig } from "./jobs.ts"
export { jobsCommand, jobsPanel, jobView, registerJobs } from "./jobs-ui.ts"
export {
  applyPatchTool,
  askUserPresenter,
  askUserTool,
  bashTool,
  builtinPresenters,
  editTool,
  globTool,
  grepTool,
  jobListTool,
  jobOutputTool,
  jobStopTool,
  outputReadTool,
  powershellTool,
  readTool,
  toolSearchExtension,
  toolSearchTool,
  writeTool,
}

/** PowerShell is offered next to bash on Windows only (D68). */
export const builtinTools = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  applyPatchTool,
  ...(process.platform === "win32" ? [powershellTool] : []),
  grepTool,
  globTool,
  outputReadTool,
  askUserTool,
  ...jobTools,
]

export default defineExtension(async (api) => {
  const tools = await availableShellTools(
    builtinTools,
    () => api.session()?.info().shell ?? api.settings.shell,
  )
  for (const tool of tools) api.registerTool(tool)
  for (const [name, presenter] of Object.entries(builtinPresenters)) api.registerToolRenderer(name, presenter)
  registerJobs(api)
  // Warm processes and Win32 bindings in the background after shell discovery.
  setTimeout(() => {
    warmUpShell()
    hostWarmUpCommands()
  }, 0)
})
