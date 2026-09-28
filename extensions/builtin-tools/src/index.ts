import { defineExtension } from "@amira/api"
import { bashTool } from "./bash.ts"
import { editTool } from "./edit.ts"
import { globTool } from "./glob.ts"
import { grepTool } from "./grep.ts"
import { warmUpProcessTree } from "./process-tree.ts"
import { readTool } from "./read.ts"
import { warmUpShell } from "./shell.ts"
import { writeTool } from "./write.ts"

export { bashTool, editTool, globTool, grepTool, readTool, writeTool }

export const builtinTools = [readTool, writeTool, editTool, bashTool, grepTool, globTool]

export default defineExtension((api) => {
  for (const tool of builtinTools) api.registerTool(tool)
  // Not awaited: loading must not wait for shell discovery or the Win32 bindings.
  setTimeout(() => {
    warmUpShell()
    try {
      warmUpProcessTree()
    } catch {}
  }, 0)
})
