import type { CommandContext, FrontendView } from "@amira/api"

type OpenView = NonNullable<CommandContext["openView"]>
type Bind = (currentRoot: () => boolean) => OpenView

// Frontends opt into context capture without adding arguments to the extension capability.
const bindings = new WeakMap<OpenView, Bind>()

export function registerCommandViewContext(open: OpenView, bind: Bind): OpenView {
  bindings.set(open, bind)
  return open
}

/** Commands, skills and input handlers all receive their own origin-bound capability. */
export function bindCommandViewContext(open: OpenView, currentRoot: () => boolean): OpenView {
  const bind = bindings.get(open)
  if (!bind) return open
  const bound = bind(currentRoot)
  // A host creating a new command context may forward the capability, but merely retaining
  // or directly calling an old context never retargets its captured conversation.
  bindings.set(bound, bind)
  return bound
}

/** Extension lifetime/ownership wrappers preserve the frontend's origin-binding factory. */
export function ownCommandViews(
  ctx: CommandContext,
  lifetime: AbortSignal,
  own: (view: FrontendView) => FrontendView,
): CommandContext {
  const open = ctx.openView
  if (!open) return ctx
  const wrap =
    (capability: OpenView): OpenView =>
    (view) =>
      !lifetime.aborted && capability(own(view))
  const wrapped = wrap(open)
  const bind = bindings.get(open)
  if (bind) bindings.set(wrapped, (currentRoot) => wrap(bind(currentRoot)))
  return { ...ctx, openView: wrapped }
}
