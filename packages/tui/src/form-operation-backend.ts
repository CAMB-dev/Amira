import type { FrontendFormBackend } from "@amira/core"
import type { FormBackend } from "./form-view.ts"

/** Adapts a local host or transport implementation without making render/input do IO. */
export function operationFormBackend(backend: FrontendFormBackend): FormBackend {
  return {
    schema: backend.schema,
    ...(backend.openEditor
      ? { openEditor: (options?: { signal?: AbortSignal }) => backend.openEditor!(options) }
      : {}),
    evaluate: (draft) => backend.evaluate(draft),
    validate: () => ({}),
    runAction: async (action, values, options) => {
      const reply = await backend.runAction(
        {
          action,
          values,
          revision: options.revision ?? 0,
          editor: options.editor,
          automatic: options.automatic,
        },
        options,
      )
      if (reply.revision !== (options.revision ?? 0) || reply.status === "stale")
        return { message: reply.message ?? "Form changed. Try the action again.", tone: "error" }
      if (reply.status === "invalid" || reply.status === "disconnected")
        return { message: reply.message, tone: "error" }
      return reply.result ?? {}
    },
    submit: async (values, options) =>
      backend.submit({ values, revision: options?.revision ?? 0, editor: options?.editor }, options),
    cancel: (editor, revision) => backend.cancel(editor, revision),
  }
}
