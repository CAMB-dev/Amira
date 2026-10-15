import { expect, test } from "bun:test"
import { rpcSchema } from "../src/rpc-schema.ts"

test("RPC schema includes additive form grouping, disclosure and recovery metadata", () => {
  const schema = rpcSchema() as any
  expect(schema.$defs.FormOption.properties.group).toEqual({ type: "string" })
  const form = schema.$defs.UiRequest.oneOf.find((variant: any) => variant.properties.kind.enum[0] === "form")
  expect(form.properties.sections.items.properties.collapsed).toEqual({ type: "boolean" })
  const progress = schema.$defs.Event.anyOf.find((event: any) =>
    event.properties.type.enum?.includes("ui.progress"),
  )
  expect(progress.properties.data.properties.form.properties.result).toEqual({
    $ref: "#/$defs/FormActionResult",
  })
  expect(progress.properties.data.properties.form.properties.errors.additionalProperties).toEqual({
    type: "string",
  })
})
