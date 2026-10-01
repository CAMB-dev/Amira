import type { FileMutation, ToolContext } from "@amira/api"

/** The host owns capture; standalone tools keep their existing behavior. */
export function mutateFiles(
  ctx: Pick<ToolContext, "mutateFiles">,
  changes: FileMutation[],
  write: () => Promise<void>,
): Promise<void> {
  return ctx.mutateFiles ? ctx.mutateFiles(changes, write) : write()
}
