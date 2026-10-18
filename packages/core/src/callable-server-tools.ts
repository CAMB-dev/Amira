import { type Ai, type ModelRequest, NATIVE_WEB_SEARCH } from "@amira/ai"

/** Hosted tools execute remotely, so excluded ones must be omitted before a request is sent. */
export function withCallableServerTools(ai: Ai, callable: ReadonlySet<string> | undefined): Ai {
  if (!callable || callable.has(NATIVE_WEB_SEARCH)) return ai
  const restrict = (request: ModelRequest): ModelRequest => ({
    ...request,
    // Do not alter the agent's model or local declarations: only this request's hosted capability.
    model: { ...request.model, caps: { ...request.model.caps, webSearch: false } },
  })
  return {
    ...ai,
    stream: (request, signal) => ai.stream(restrict(request), signal),
    compact: (request, signal, onProgress, onUsage) =>
      ai.compact(restrict(request), signal, onProgress, onUsage),
  }
}
