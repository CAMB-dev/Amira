import type { FormOperationOptions, FrontendFormBackend } from "@amira/core"
import type { RemoteAgentPort } from "./agent-port.ts"
import { RemoteError, RemoteReplyError } from "./errors.ts"

/** Local presentation callbacks stay local; validation/actions execute only in the remote host. */
export function createRemoteFormBackend(
  port: RemoteAgentPort,
  request: Extract<RemoteAgentPort["pendingRequests"][number], { kind: "form" }>,
): FrontendFormBackend {
  const {
    requestId,
    kind: _kind,
    source: _source,
    sourceLabel: _label,
    sessionId: _session,
    ...schema
  } = request
  const generation = port.identity.sessionGeneration
  async function progress<T>(options: FormOperationOptions, run: () => Promise<T>): Promise<T> {
    const off = port.subscribeEvents((event, context) => {
      if (
        !context.replay &&
        !options.signal?.aborted &&
        event.type === "ui.progress" &&
        event.data.requestId === requestId
      )
        options.onProgress?.(event.data.text)
    })
    try {
      return await run()
    } finally {
      off()
    }
  }
  // A failed attachment can have accepted form.open without delivering its claim. Keep the
  // mounted view's admission pending and replay its identity, never replace the host editor.
  function connected(signal?: AbortSignal, previous?: RemoteAgentPort["authority"]): Promise<void> {
    return new Promise((resolve, reject) => {
      let off = () => {}
      const finish = (error?: RemoteError) => {
        off()
        signal?.removeEventListener("abort", check)
        if (error) reject(error)
        else resolve()
      }
      const check = () => {
        if (signal?.aborted) finish(new RemoteError("cancelled", "Remote request cancelled"))
        else if (port.status === "detached")
          finish(new RemoteError("disconnected", "Remote frontend detached"))
        else if (port.status === "connected" && port.authority !== previous) finish()
      }
      off = port.subscribeStatus(check)
      signal?.addEventListener("abort", check, { once: true })
      check()
    })
  }
  async function recover<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let previous: RemoteAgentPort["authority"]
    while (true) {
      await connected(signal, previous)
      const authority = port.authority
      try {
        return await run()
      } catch (error) {
        if (
          signal?.aborted ||
          error instanceof RemoteReplyError ||
          (error instanceof RemoteError && error.code !== "disconnected")
        )
          throw error
        // EOF may reject before the disconnected notification. Wait for a different
        // welcome, not merely the old attachment still momentarily marked connected.
        previous = authority
      }
    }
  }
  let evaluating: AbortController | undefined
  return {
    schema,
    openEditor(options = {}) {
      const operationId = crypto.randomUUID()
      return recover(
        () =>
          port.request(
            "form.open",
            { requestId },
            { ...options, operationId, sessionGeneration: generation },
          ),
        options.signal,
      )
    },
    async evaluate(draft) {
      // Only the latest presentation read survives reconnect. The host caches change
      // results by editor/revision, so a lost reply can be read again without a new claim.
      evaluating?.abort()
      const controller = new AbortController()
      evaluating = controller
      try {
        return await recover(
          () =>
            port.request(
              "form.evaluate",
              { requestId, draft },
              { signal: controller.signal, sessionGeneration: generation },
            ),
          controller.signal,
        )
      } finally {
        if (evaluating === controller) evaluating = undefined
      }
    },
    runAction: (draft, options = {}) =>
      progress(options, () =>
        port.request(
          "form.action",
          { requestId, draft },
          { signal: options.signal, sessionGeneration: generation },
        ),
      ),
    submit: (draft, options = {}) =>
      progress(options, () =>
        port.request(
          "form.submit",
          { requestId, draft },
          { signal: options.signal, sessionGeneration: generation },
        ),
      ),
    async cancel(editor, revision) {
      // Discard presentation work, not the draft. Cancellation need not first admit
      // an offline revision, and unlike evaluation this mutation is never replayed.
      evaluating?.abort()
      await connected()
      return port.request(
        "form.cancel",
        { requestId, ...(editor !== undefined && { editor }), ...(revision !== undefined && { revision }) },
        { sessionGeneration: generation },
      )
    },
  }
}
