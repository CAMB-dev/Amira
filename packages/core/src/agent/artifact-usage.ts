// Owns artifact discovery, reference classification, usage aggregation and pruning.
import type { Message } from "@amira/ai"
import type { ArtifactGroupUsage, ArtifactInfo } from "@amira/api"
import {
  type ArtifactScope,
  ArtifactStore,
  type ArtifactUsage,
  artifactDir,
  artifactIdsIn,
  referencedArtifacts,
  subagentSessionFiles,
} from "../artifacts.ts"
import { SessionStore } from "../session-store.ts"

/** Internal session view; getters keep discovery reads lazy and pruning's child check first. */
export interface ArtifactSession {
  readonly sessionId: string
  readonly artifacts: ArtifactStore
  readonly session: { file: string; entries: readonly object[] } | undefined
  readonly messages: readonly Message[]
  projectedMessages(): readonly Message[]
  readonly children: readonly { id: string; title: string }[]
  subagent(id: string): { readonly messages?: readonly Message[] } | undefined
}

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

/** Builds the parent and sub-agent stores with one consistent reference snapshot. */
export function discoverArtifactGroups(session: ArtifactSession): ManagedArtifactGroup[] {
  const initiallyActive = activeArtifactIds([session.messages, session.projectedMessages()])
  const referenced = session.session ? referencedArtifacts(session.session) : initiallyActive
  const labels = new Map<string, string>()
  const rememberLabels = (entries: readonly object[]) => {
    for (const e of entries) {
      if ((e as { type?: unknown }).type !== "subagent") continue
      const id = (e as { childSessionId?: unknown }).childSessionId
      if (typeof id !== "string") continue
      const role = (e as { role?: unknown }).role
      const title = (e as { title?: unknown }).title
      labels.set(
        id,
        `Sub-agent: ${typeof title === "string" && title ? title : typeof role === "string" && role ? role : id} (${id})`,
      )
    }
  }
  const files = session.session ? subagentSessionFiles(session.session) : []
  if (session.session) {
    rememberLabels(session.session.entries)
    for (const child of files) rememberLabels(child.entries)
  }
  const live = new Set(session.children.map((child) => child.id))
  for (const child of session.children) labels.set(child.id, `Sub-agent: ${child.title} (${child.id})`)
  const childMessages: (readonly Message[])[] = []
  for (const child of files) {
    const known = session.subagent(child.id)
    if (known?.messages) childMessages.push(known.messages)
    else {
      try {
        childMessages.push(SessionStore.open(child.file).restore().messages)
      } catch {
        // A torn or foreign child file has no current context to classify as active.
      }
    }
  }

  const active = new Set(initiallyActive)
  for (const id of activeArtifactIds(childMessages)) active.add(id)
  const inputs: ArtifactUsageGroupInput[] = [
    {
      store: session.artifacts,
      artifacts: session.artifacts.list(),
      id: session.sessionId,
      label: "This session",
      protectedStore: live.size > 0,
    },
  ]
  for (const child of files) {
    const store = new ArtifactStore({
      dir: artifactDir(child.file, child.id),
      sessionId: child.id,
      limits: session.artifacts.limits,
      quotaBytes: session.artifacts.quotaBytes,
    })
    inputs.push({
      store,
      artifacts: store.list(),
      id: child.id,
      label: labels.get(child.id) ?? `Sub-agent: ${child.id} (${child.id})`,
      protectedStore: live.has(child.id),
    })
  }
  return buildArtifactUsageGroups(active, referenced, inputs)
}

/** Deletes selected artifacts sequentially, retaining their metadata, only with no live children. */
export async function pruneArtifacts(
  session: ArtifactSession,
  scope: ArtifactScope,
): Promise<{ removed: number; bytes: number }> {
  if (session.children.length) {
    throw new Error(
      "cannot prune artifacts while a sub-agent is running, queued or idle; wait for it to finish or stop it (/agents stop)",
    )
  }
  let removed = 0
  let bytes = 0
  for (const { group, ids } of artifactIdsToPrune(discoverArtifactGroups(session), scope)) {
    const result = await group.store.prune(ids)
    removed += result.removed
    bytes += result.bytes
  }
  return { removed, bytes }
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
