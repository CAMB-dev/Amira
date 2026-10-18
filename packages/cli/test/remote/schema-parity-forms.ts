import type {
  AskAnswer,
  ExtensionSettingField,
  FormActionResult,
  FormFieldSchema,
  FormOption,
  FormSchema,
  FormValue,
  FormValues,
  ToolLine,
  UiAnswer,
} from "@amira/api"
import type { FormDraft, FormEvaluation, FormMutationResult, UiResponseAck } from "@amira/core"
import { object } from "../../src/remote/schema/base.ts"
import * as schema from "../../src/remote/schema/forms.ts"
import type { ServerUiRequest } from "../../src/server/runtime.ts"
import type { AssertNone, Difference } from "./schema-parity-types.ts"

const form = object(schema.formSchema)
const draft = object(schema.formDraft)
type Checked =
  | "formValue"
  | "formValues"
  | "formOption"
  | "formAction"
  | "formField"
  | "formSchema"
  | "toolLine"
  | "settingField"
  | "askAnswer"
  | "uiRequest"
  | "uiAnswer"
  | "uiAck"
  | "formDraft"
  | "formMutation"
  | "formEvaluation"
export type FormSchemaParity = [
  AssertNone<Exclude<keyof typeof schema, Checked> | Exclude<Checked, keyof typeof schema>>,
  AssertNone<Difference<typeof schema.formValue, FormValue>>,
  AssertNone<Difference<typeof schema.formValues, FormValues>>,
  AssertNone<Difference<typeof schema.formOption, FormOption>>,
  AssertNone<Difference<typeof schema.formAction, FormActionResult>>,
  AssertNone<Difference<typeof schema.formField, FormFieldSchema>>,
  AssertNone<Difference<typeof form, FormSchema>>,
  AssertNone<Difference<typeof schema.toolLine, ToolLine>>,
  AssertNone<Difference<typeof schema.settingField, ExtensionSettingField>>,
  AssertNone<Difference<typeof schema.askAnswer, AskAnswer>>,
  AssertNone<Difference<typeof schema.uiRequest, ServerUiRequest>>,
  AssertNone<Difference<typeof schema.uiAnswer, UiAnswer[Exclude<keyof UiAnswer, "form">] | null>>,
  AssertNone<Difference<typeof schema.uiAck, UiResponseAck>>,
  AssertNone<Difference<typeof draft, FormDraft>>,
  AssertNone<Difference<typeof schema.formMutation, FormMutationResult>>,
  AssertNone<Difference<typeof schema.formEvaluation, FormEvaluation>>,
]
