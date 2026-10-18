import { expect, test } from "bun:test"
import { rpcSchema } from "../src/rpc-schema.ts"

test("RPC schema exposes optional package lifecycle badges in management requests", () => {
  const schema = rpcSchema() as any
  expect(schema.$defs.ExtensionStatusMetadata.properties.status).toEqual({
    enum: ["experimental", "wip", "deprecated"],
  })
  const select = schema.$defs.UiRequest.oneOf.find(
    (variant: any) => variant.properties.kind.enum[0] === "select",
  )
  expect(select.properties.optionExtensionStatuses.items.oneOf).toContainEqual({
    $ref: "#/$defs/ExtensionStatusMetadata",
  })
  expect(select.required).not.toContain("optionExtensionStatuses")
  const settings = schema.$defs.UiRequest.oneOf.find(
    (variant: any) => variant.properties.kind.enum[0] === "extension-settings",
  )
  expect(settings.properties.extensionStatus).toEqual({ $ref: "#/$defs/ExtensionStatusMetadata" })
  expect(settings.required).not.toContain("extensionStatus")
})
