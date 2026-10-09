import { expect, test } from "bun:test"
import { rpcSchema } from "../src/rpc-schema.ts"

test("the RPC schema adds stream timing events without requiring new metadata", () => {
  const defs = (rpcSchema() as any).$defs
  const stream = defs.Event.anyOf.find((e: any) => e.properties.type.enum[0] === "message.stream")
  const variants = stream.properties.data.oneOf
  const request = variants.find((v: any) => v.properties.kind.enum[0] === "request")
  expect(request.properties.thinkingDisplay.enum).toEqual(["summarized", "omitted", "raw"])
  expect(request.required).toEqual(["kind"])
  const boundaries = variants.find((v: any) => v.properties.kind.enum.includes("thinkingEnd"))
  expect(boundaries.properties.kind.enum).toEqual(["contentStart", "thinkingStart", "thinkingEnd"])
  expect(boundaries.required).toEqual(["kind"])
  const end = variants.find((v: any) => v.properties.kind.enum[0] === "end")
  expect(end.properties.outputTokens.type).toBe("number")
  expect(end.required).toEqual(["kind"])
  const turn = defs.Event.anyOf.find((e: any) => e.properties.type.enum[0] === "turn.start")
  expect(turn.properties.data.required).toEqual(["prompt"])
  expect(turn.properties.data.properties.sentAt.type).toBe("number")
})
