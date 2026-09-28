import { defineExtension } from "@amira/api"
import { bashTool } from "./bash.ts"
import { editTool } from "./edit.ts"
import { globTool } from "./glob.ts"
import { grepTool } from "./grep.ts"
import { readTool } from "./read.ts"
import { writeTool } from "./write.ts"

export { bashTool, editTool, globTool, grepTool, readTool, writeTool }

export const builtinTools = [readTool, writeTool, editTool, bashTool, grepTool, globTool]

export default defineExtension((api) => {
  for (const tool of builtinTools) api.registerTool(tool)
})
