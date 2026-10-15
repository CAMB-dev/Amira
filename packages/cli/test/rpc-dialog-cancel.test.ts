import { expect, test } from "bun:test"
import { createAi, createMockDialect } from "@amira/ai"
import { defineExtension, defineTool, textResult } from "@amira/api"
import { runRpc } from "../src/rpc.ts"
import { createSession } from "../src/session.ts"

test("RPC EOF cancels a callback-dependent form while its final check is pending", async () => {
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<AbortSignal>()
  let saves = 0
  const extension = defineExtension((api) => {
    api.registerTool(
      defineTool({
        name: "configure",
        description: "",
        parameters: { type: "object" },
        execute: async () => {
          const values = await api.ui.form({
            title: "EOF-safe provider setup",
            fields: [],
            preview: () => ["masked preview"],
            beforeSubmit: async ({ signal }) => {
              started.resolve(signal)
              await gate.promise
              return undefined
            },
          })
          if (values) saves++
          return textResult(values ? "saved" : "cancelled")
        },
      }),
    )
  })
  const ai = createAi({
    dialects: [createMockDialect([{ toolCalls: [{ name: "configure", args: {} }] }, { text: "done" }])],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  })
  const session = await createSession({
    model: "mock/m",
    ai,
    cwd: import.meta.dir,
    extensions: [],
    noBuiltins: false,
    builtins: async () => [{ source: "rpc-cancel", extension }],
  })
  let input: ReadableStreamDefaultController<string> | undefined
  const stream = new ReadableStream<string>({
    start(controller) {
      controller.enqueue(JSON.stringify({ id: 1, cmd: "prompt", text: "go" }))
      input = controller
    },
  })
  const output: Record<string, any>[] = []
  const rpc = runRpc(
    { agent: session.agent, ai, ui: session.host.ui },
    {
      io: {
        lines: stream,
        write: (line) => {
          output.push(JSON.parse(line))
        },
      },
    },
  )
  const deadline = Date.now() + 3000
  while (!output.some((line) => line.type === "ui.request")) {
    if (Date.now() > deadline) throw new Error("RPC did not ask the final confirmation")
    await Bun.sleep(1)
  }
  const request = output.find((line) => line.type === "ui.request")!
  expect(request.data.kind).toBe("select")
  input!.enqueue(
    JSON.stringify({ id: 2, cmd: "ui.respond", requestId: request.data.requestId, value: "Save" }),
  )
  const signal = await started.promise
  input!.close()
  for (let tick = 0; tick < 100 && !signal.aborted; tick++) await Bun.sleep(1)
  const cancelledAtEof = signal.aborted
  gate.resolve()
  expect(await rpc).toBe(0)
  expect(cancelledAtEof).toBe(true)
  expect(saves).toBe(0)
})
