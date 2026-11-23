// Host-facing internal seams exported by @amira/core for @amira/host.
export { subscribeHolds } from "./agent/hold.ts"
export { type AgentHostHooks, registerAgentHostHooks } from "./agent/host-hooks.ts"
export { drainOwnedTools, runOwnedTool } from "./agent/owned-tool.ts"
export { PauseGate } from "./agent/pause.ts"
export type { AgentTreeHost, AgentTreeScope } from "./agent/types.ts"
export { withCallableServerTools } from "./callable-server-tools.ts"
export { extensionDataOwner } from "./extension-data.ts"
export type { PermissionLayer } from "./permissions/settings.ts"
export {
  intersectWriteRoots,
  validateStoredWriteRoots,
  validateWriteRoots,
} from "./permissions/write-roots.ts"
export { canonicalSessionFile } from "./session-path.ts"
export { writeAtomicFile } from "./session-store.ts"
export {
  accountUsage,
  cloneUsage,
  emitBudgetUpdate,
  entryUsage,
  incompleteUsage,
  negateUsage,
  storedSessionUsage,
  type UsageAttribution,
  usageDelta,
  usageSnapshot,
} from "./session-usage.ts"
