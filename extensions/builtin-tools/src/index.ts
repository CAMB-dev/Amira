import { defineExtension } from "@amira/api"
import { warmUpCommands } from "@amira/proc"
import { bashTool, powershellTool } from "./bash.ts"
import { editTool } from "./edit.ts"
import { globTool } from "./glob.ts"
import { grepTool } from "./grep.ts"
import { readTool } from "./read.ts"
import { warmUpShell } from "./shell.ts"
import { writeTool } from "./write.ts"

export { bashTool, editTool, globTool, grepTool, powershellTool, readTool, writeTool }

/** PowerShell is offered next to bash on Windows only (D68). */
export const builtinTools = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  ...(process.platform === "win32" ? [powershellTool] : []),
  grepTool,
  globTool,
]

export default defineExtension((api) => {
  for (const tool of builtinTools) api.registerTool(tool)
  // Not awaited: loading must not wait for shell discovery or the Win32 bindings.
  setTimeout(() => {
    warmUpShell()
    warmUpCommands()
  }, 0)
})
