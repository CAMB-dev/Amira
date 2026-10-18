import { expect, test } from "bun:test"
import { rpcSchema } from "../src/rpc-schema.ts"

test("RPC schema includes additive form grouping, disclosure and recovery metadata", () => {
  const schema = rpcSchema() as any
  expect(schema.$defs.FormOption.properties.group).toEqual({ type: "string" })
  const form = schema.$defs.UiRequest.oneOf.find((variant: any) => variant.properties.kind.enum[0] === "form")
  expect(form.properties.sections.items.properties.collapsed).toEqual({ type: "boolean" })
  expect(form.properties.layout).toEqual({ enum: ["card"] })
  expect(form.required).not.toContain("layout")
  expect(form.properties.summaries.items.properties.summaryFields).toEqual({
    type: "array",
    items: { type: "string" },
  })
  expect(form.required).not.toContain("summaries")
  const action = schema.$defs.FormField.oneOf.find((field: any) => field.properties.type.enum[0] === "action")
  expect(action.properties.placement).toEqual({ enum: ["footer"] })
  expect(action.properties.buttonLabel).toEqual({ type: "string" })
  expect(action.properties.shortcut).toEqual({ enum: ["ctrl+t"] })
  expect(action.properties.inline).toEqual({ type: "string" })
  expect(action.required).not.toContain("placement")
  expect(action.required).not.toContain("buttonLabel")
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
