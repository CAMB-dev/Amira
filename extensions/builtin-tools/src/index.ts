import { defineExtension } from "@amira/api"
import { warmUpCommands } from "@amira/proc"
import { applyPatchTool } from "./apply-patch.ts"
import { askUserPresenter, askUserTool } from "./ask-user.ts"
import { bashTool, powershellTool } from "./bash.ts"
import { editTool } from "./edit.ts"
import { globTool } from "./glob.ts"
import { grepTool } from "./grep.ts"
import { builtinPresenters } from "./presenters.ts"
import { readTool } from "./read.ts"
import { warmUpShell } from "./shell.ts"
import { writeTool } from "./write.ts"

export {
  applyPatchTool,
  askUserPresenter,
  askUserTool,
  bashTool,
  builtinPresenters,
  editTool,
  globTool,
  grepTool,
  powershellTool,
  readTool,
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
  askUserTool,
]

export default defineExtension((api) => {
  for (const tool of builtinTools) api.registerTool(tool)
  for (const [name, presenter] of Object.entries(builtinPresenters)) api.registerToolRenderer(name, presenter)
  // Not awaited: loading must not wait for shell discovery or the Win32 bindings.
  setTimeout(() => {
    warmUpShell()
    warmUpCommands()
  }, 0)
})
