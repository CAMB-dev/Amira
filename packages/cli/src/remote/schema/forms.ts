import {
  array,
  bool,
  integer,
  nil,
  number,
  object,
  record,
  text,
  union,
  enumeration as values,
} from "./base.ts"

export const formValue = union(text, number, bool, array(text))
export const formValues = record(formValue)
export const formOption = object({
  value: text,
  "group?": text,
  "label?": text,
  "description?": text,
  "detail?": union(text, array(text)),
})
export const formAction = object({
  "message?": text,
  "tone?": values("info", "success", "warning", "error"),
  "values?": formValues,
  "options?": record(array(formOption)),
})
const fieldWhen = object({ field: text, is: union(formValue, array(formValue)) })
const fieldBase = {
  id: text,
  label: text,
  "help?": text,
  "section?": text,
  "when?": fieldWhen,
}
const textOptions = { "placeholder?": text, "required?": bool }
export const formField = union(
  object({
    type: values("text"),
    ...fieldBase,
    ...textOptions,
    "default?": text,
    "pattern?": text,
    "patternMessage?": text,
    "maxLength?": number,
  }),
  object({ type: values("secret"), ...fieldBase, ...textOptions }),
  object({
    type: values("number"),
    ...fieldBase,
    ...textOptions,
    "default?": number,
    "min?": number,
    "max?": number,
    "integer?": bool,
  }),
  object({ type: values("select"), ...fieldBase, options: array(formOption), "default?": text }),
  object({
    type: values("multiselect"),
    ...fieldBase,
    options: array(formOption),
    "default?": array(text),
    "required?": bool,
    "allowCustom?": bool,
  }),
  object({ type: values("checkbox"), ...fieldBase, "default?": bool }),
  object({
    type: values("textarea"),
    ...fieldBase,
    ...textOptions,
    "default?": text,
    "rows?": number,
    "maxLength?": number,
  }),
  object({
    type: values("action"),
    ...fieldBase,
    "placement?": values("footer"),
    "buttonLabel?": text,
    "shortcut?": values("ctrl+t"),
    "inline?": text,
    "recommended?": bool,
    "auto?": object({ watch: array(union(text, object({ field: text, when: formValues }))) }),
  }),
)
export const formSchema = {
  title: text,
  "layout?": values("card"),
  "description?": text,
  fields: array(formField),
  "sections?": array(object({ title: text, "collapsed?": bool, "help?": text, "optional?": bool })),
  "summaries?": array(
    object({
      id: text,
      label: text,
      fields: array(text),
      summaryFields: array(text),
      "when?": fieldWhen,
    }),
  ),
  "submitLabel?": text,
}
export const toolLine = object({
  kind: values(
    "text",
    "muted",
    "accent",
    "success",
    "warning",
    "error",
    "code",
    "diff-add",
    "diff-remove",
    "diff-context",
    "diff-hunk",
  ),
  text,
  "lineNo?": number,
  "wrap?": bool,
  "marker?": values("success", "unchecked"),
  "description?": text,
})
const settingBase = { key: text, label: text, "description?": text }
export const settingField = union(
  object({
    type: values("number"),
    ...settingBase,
    default: number,
    "min?": number,
    "max?": number,
    "step?": number,
  }),
  object({ type: values("toggle"), ...settingBase, default: bool }),
  object({
    type: values("choice"),
    ...settingBase,
    default: text,
    options: array(union(text, object({ value: text, "label?": text, "description?": text }))),
  }),
  object({
    type: values("text"),
    ...settingBase,
    default: text,
    "placeholder?": text,
    "pattern?": text,
    "maxLength?": number,
  }),
  object({ type: values("colour"), ...settingBase, default: text }),
)
export const askAnswer = object({ selected: array(text), "other?": text })
const pendingBase = { requestId: text, "sessionId?": text, "source?": text, "sourceLabel?": text }
const extensionStatus = object({
  "status?": values("experimental", "wip", "deprecated"),
  "statusMessage?": text,
  "replacedBy?": text,
})
export const uiRequest = union(
  object({
    ...pendingBase,
    kind: values("select"),
    title: text,
    options: array(text),
    "optionLabels?": array(text),
    "initial?": text,
    "sections?": array(
      object({
        at: number,
        "title?": text,
        "choose?": text,
        "keys?": array(object({ key: text, label: text })),
      }),
    ),
    "descriptions?": array(text),
    "optionStatuses?": array(
      union(values("queued", "working", "idle", "paused", "done", "failed", "stopped"), nil),
    ),
    "optionExtensionStatuses?": array(union(extensionStatus, nil)),
    "searchTexts?": array(text),
  }),
  object({
    ...pendingBase,
    kind: values("confirm"),
    title: text,
    "message?": text,
    "always?": union(bool, text),
    "other?": bool,
    "preview?": array(toolLine),
  }),
  object({
    ...pendingBase,
    kind: values("input"),
    title: text,
    "placeholder?": text,
    "initial?": text,
    "secret?": bool,
  }),
  object({ ...pendingBase, kind: values("diff-review"), title: text, diff: text, options: array(text) }),
  object({
    ...pendingBase,
    kind: values("ask"),
    title: text,
    questions: array(
      object({
        question: text,
        "header?": text,
        options: array(object({ label: text, "description?": text })),
        "multiSelect?": bool,
      }),
    ),
  }),
  object({ ...pendingBase, kind: values("form"), ...formSchema }),
  object({
    ...pendingBase,
    kind: values("extension-settings"),
    name: text,
    title: text,
    "extensionStatus?": extensionStatus,
    fields: array(settingField),
    values: record(union(text, number, bool)),
    "sources?": record(values("user", "project", "project-local", "flags")),
    scope: values("user", "project"),
  }),
)
export const uiAnswer = union(
  nil,
  bool,
  text,
  object({ other: text }),
  object({ option: text, "key?": text }),
  array(askAnswer),
  object({ values: record(union(text, number, bool)), scope: values("user", "project") }),
)
export const uiAck = union(
  object({ status: values("accepted", "cancelled", "settled") }),
  object({ status: values("invalid", "disconnected"), message: text }),
)
export const formDraft = { "editor?": text, revision: integer, values: formValues }
export const formMutation = object({
  revision: integer,
  status: values("accepted", "cancelled", "settled", "invalid", "disconnected", "stale"),
  "result?": formAction,
  "message?": text,
})
export const formEvaluation = object({
  revision: integer,
  errors: record(text),
  visible: record(bool),
  preview: array(text),
  autoActions: array(text),
  change: formAction,
})
