import type { Message } from "@amira/ai"
import type { ArtifactGroupUsage, ArtifactInfo } from "@amira/api"
import { type ArtifactScope, type ArtifactStore, type ArtifactUsage, artifactIdsIn } from "../artifacts.ts"

export interface ManagedArtifactGroup {
  store: ArtifactStore
  buckets: ArtifactUsage
  usage: ArtifactGroupUsage
}

export interface ArtifactUsageGroupInput {
  store: ArtifactStore
  artifacts: readonly ArtifactInfo[]
  id: string
  label: string
  protectedStore: boolean
}

/** Every artifact id mentioned by the supplied context message lists. */
export function activeArtifactIds(messageLists: readonly (readonly Message[])[]): Set<string> {
  const active = new Set<string>()
  for (const messages of messageLists) {
    for (const message of messages) {
      for (const block of message.content) {
        if (block.type === "text") for (const id of artifactIdsIn(block.text)) active.add(id)
        else if (block.type === "toolCall")
          for (const id of artifactIdsIn(JSON.stringify(block.args))) active.add(id)
      }
    }
  }
  return active
}

/** Classifies explicit artifact metadata into the buckets used by reporting and /prune. */
export function buildArtifactUsageGroups(
  active: ReadonlySet<string>,
  referenced: ReadonlySet<string>,
  inputs: readonly ArtifactUsageGroupInput[],
): ManagedArtifactGroup[] {
  return inputs.map((input) => {
    const buckets: ArtifactUsage = { active: [], inactive: [], unused: [], pruned: [], bytes: 0 }
    for (const artifact of input.artifacts) {
      if (artifact.pruned) buckets.pruned.push(artifact)
      else {
        buckets.bytes += artifact.bytes
        if (active.has(artifact.id)) buckets.active.push(artifact)
        else if (referenced.has(artifact.id)) buckets.inactive.push(artifact)
        else buckets.unused.push(artifact)
      }
    }
    return {
      store: input.store,
      buckets,
      usage: {
        id: input.id,
        label: input.label,
        active: buckets.active.length,
        inactive: buckets.inactive.length,
        unused: buckets.unused.length,
        pruned: buckets.pruned.length,
        bytes: buckets.bytes,
        quotaBytes: input.store.quotaBytes,
        dir: input.store.dir,
        ...(input.protectedStore ? { protected: true } : {}),
      },
    }
  })
}

/** Combines per-session buckets into the aggregate exposed by Agent.artifactUsage. */
export function summarizeArtifactUsage(groups: readonly ManagedArtifactGroup[]): ArtifactUsage {
  const out: ArtifactUsage = { active: [], inactive: [], unused: [], pruned: [], bytes: 0 }
  for (const group of groups) {
    out.active.push(...group.buckets.active)
    out.inactive.push(...group.buckets.inactive)
    out.unused.push(...group.buckets.unused)
    out.pruned.push(...group.buckets.pruned)
    out.bytes += group.usage.bytes
  }
  out.groups = groups.map((group) => group.usage)
  return out
}

/** Selects the ids a prune scope is allowed to delete, without touching a store. */
export function artifactIdsToPrune(
  groups: readonly ManagedArtifactGroup[],
  scope: ArtifactScope,
): { group: ManagedArtifactGroup; ids: string[] }[] {
  return groups.map((group) => {
    const artifacts =
      scope === "unused"
        ? group.buckets.unused
        : scope === "inactive"
          ? [...group.buckets.unused, ...group.buckets.inactive]
          : [...group.buckets.unused, ...group.buckets.inactive, ...group.buckets.active]
    return { group, ids: artifacts.map((artifact) => artifact.id) }
  })
}
