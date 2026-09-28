import { defineExtension, defineTool, textResult } from "@amira/api"

/** Tools for the rpc end-to-end tests: one that takes a while, one that asks the user. */
export default defineExtension((api) => {
  api.registerTool(
    defineTool<{ ms: number }>({
      name: "wait",
      description: "Waits",
      parameters: { type: "object", properties: { ms: { type: "number" } } },
      execute: async (p) => {
        await Bun.sleep(p.ms)
        return textResult("waited")
      },
    }),
  )
  api.registerTool(
    defineTool({
      name: "ask",
      description: "Asks",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        const answer = await api.ui.confirm("Deploy?", "to production")
        return textResult(`answer: ${answer ?? "nobody answered"}`)
      },
    }),
  )
})
