import { expect, test } from "bun:test"
import { rpcSchema } from "../src/rpc-schema.ts"

test("RPC budget updates expose an optional accumulated estimate marker", () => {
  const defs = (rpcSchema() as any).$defs
  const event = defs.Event.anyOf.find((entry: any) => entry.properties.type.enum[0] === "budget.update")
  expect(event.properties.data.properties.pricingUnknown).toEqual({ type: "boolean" })
  expect(event.properties.data.required).toEqual(["tokens"])
  expect(event.properties.data.properties.costUsd).toEqual({ type: "number" })
})

test("RPC group usage keeps the estimate marker in every snapshot event", () => {
  const defs = (rpcSchema() as any).$defs
  for (const type of ["group.start", "group.update", "group.end"]) {
    const event = defs.Event.anyOf.find((entry: any) => entry.properties.type.enum[0] === type)
    const usage = event.properties.data.properties.group.properties.usage
    expect(usage.properties.pricingUnknown).toEqual({ type: "boolean" })
    expect(usage.properties.speed).toEqual({ enum: ["fast", "standard"] })
    expect(usage.properties.serviceTier).toEqual({ type: "string" })
    expect(usage.required).toEqual(["input", "output", "cacheRead", "cacheWrite"])
  }
})
