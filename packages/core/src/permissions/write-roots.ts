import { lstatSync, statSync } from "node:fs"
import path from "node:path"
import type { ToolDefinition } from "@amira/api"
import { toolTraits } from "../tool-traits.ts"
import { existingPrefix, safeName, safeParents, within } from "./path-containment.ts"
import { toolPath, writtenPaths } from "./protected.ts"

/** Validate persisted path spelling only; historical evidence grants no filesystem authority. */
export function validateStoredWriteRoots(
  value: readonly string[] | undefined,
): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error("writeRoots must be an array of absolute paths")
  for (const root of value) {
    if (typeof root !== "string" || safeName(root, true) !== root || path.resolve(root) !== root)
      throw new Error("persisted writeRoots must contain canonical absolute paths")
  }
  if (JSON.stringify([...new Set(value)].sort()) !== JSON.stringify(value))
    throw new Error("persisted writeRoots changed identity")
  return value
}

/** Canonicalize new roots once; established ceilings retain their spelling and original identities. */
export function validateWriteRoots(value: readonly string[] | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error("writeRoots must be an array of absolute paths")
  const established = establishedPolicies.get(value)
  if (established) {
    established.assertUnchanged()
    return established.roots
  }
  const roots = value.map((root) => {
    if (typeof root !== "string" || !safeName(root, true) || !safeParents(process.cwd(), root, {}))
      throw new Error("writeRoots must contain safe absolute paths")
    const real = existingPrefix(safeName(toolPath(process.cwd(), root), true)!, true)
    if (!real) throw new Error("Cannot resolve writeRoots")
    return real
  })
  const validated = Object.freeze([...new Set(roots)].sort())
  writeRootPolicy(validated)
  return validated
}

// Established ceilings travel through AgentOptions as frozen root arrays, without adding a
// public policy option. Their spelling and original identities are authority, not fresh requests.
const establishedPolicies = new WeakMap<readonly string[], WriteRootPolicy>()

export function writeRootPolicy(roots: readonly string[]): WriteRootPolicy {
  let policy = establishedPolicies.get(roots)
  if (!policy) {
    policy = new WriteRootPolicy(roots)
    establishedPolicies.set(roots, policy)
  }
  return policy
}

/** Intersection, not replacement: an omitted child ceiling inherits, and [] stays empty. */
export function intersectWriteRoots(
  parent: readonly string[] | undefined,
  requested: readonly string[] | undefined,
): readonly string[] | undefined {
  const ceiling =
    parent === undefined
      ? undefined
      : (establishedPolicies.get(parent) ?? writeRootPolicy(validateWriteRoots(parent)!))
  const inherited = requested === undefined ? undefined : establishedPolicies.get(requested)
  ceiling?.assertUnchanged()
  inherited?.assertUnchanged()
  parent = ceiling?.roots
  // Only newly requested paths may be canonicalized. Re-resolving an established A after it
  // becomes a junction to B would silently replace the inherited ceiling with B.
  const child = inherited ? requested : validateWriteRoots(requested)
  if (parent === undefined && child === undefined) return undefined
  const roots = Object.freeze(
    parent === undefined
      ? [...child!]
      : child === undefined
        ? [...parent]
        : [
            ...new Set(
              parent.flatMap((p) => child.flatMap((c) => (within(c, p) ? [c] : within(p, c) ? [p] : []))),
            ),
          ].sort(),
  )
  const policies = [ceiling, inherited].filter((policy): policy is WriteRootPolicy => policy !== undefined)
  establishedPolicies.set(roots, new WriteRootPolicy(roots, policies))
  return roots
}

type Identity = { name: string; dev: bigint; ino: bigint; file: boolean }

/** Snapshot existing ancestors as well as destinations, detecting replacement across awaits. */
function identities(names: readonly string[]): Identity[] {
  const found = new Map<string, Identity>()
  for (const name of names) {
    let current = name
    for (;;) {
      try {
        // NTFS inode identifiers can exceed Number's integer precision.
        const entry = lstatSync(current, { bigint: true })
        const stat = statSync(current, { bigint: true })
        if (stat.isFile() && stat.nlink > 1n) throw new Error("multi-link file target")
        // Resolve links separately, but also pin the directory entry itself.
        found.set(current, { name: current, dev: entry.dev, ino: entry.ino, file: stat.isFile() })
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
      }
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  return [...found.values()]
}

function unchanged(entries: readonly Identity[]): void {
  for (const entry of entries) {
    const now = lstatSync(entry.name, { bigint: true })
    if (now.dev !== entry.dev || now.ino !== entry.ino) throw new Error("write path identity changed")
  }
}

/** A recheck whose declared file targets can advance after a successful mutation. */
export type WritePathCheck = (() => void) & {
  /** Prepare before writing; commit only after the writer succeeds. */
  mutation(paths: readonly string[]): () => void
}

/** File-tool boundary only; shell processes and trusted extension code are not sandboxed. */
export class WriteRootPolicy {
  readonly roots: readonly string[]
  #anchors: Identity[]

  constructor(roots: readonly string[], inherited: readonly WriteRootPolicy[] = []) {
    this.roots = roots
    this.#anchors = [...inherited.flatMap((policy) => policy.#anchors), ...identities(roots)]
  }

  assertUnchanged(): void {
    unchanged(this.#anchors)
  }

  check(cwd: string, paths: readonly string[] | undefined): WritePathCheck {
    if (!paths || paths.length === 0) throw new Error("File write ceiling: no complete write-path report")
    const resolve = (paths: readonly string[]) => {
      unchanged(this.#anchors)
      const names: string[] = []
      for (const reported of paths) {
        if (typeof reported !== "string" || !safeName(reported, false) || !safeParents(cwd, reported, {}))
          throw new Error("File write ceiling: invalid write path")
        const abs = safeName(toolPath(cwd, reported), true)
        const real = abs && existingPrefix(abs)
        if (!real || !this.roots.some((root) => within(real, root)))
          throw new Error("File write ceiling: path is outside writeRoots or cannot be resolved")
        names.push(abs!, real)
      }
      return names
    }
    const names = resolve(paths)
    // Pin both link entries and resolved ancestor identities, rejecting multi-link files.
    let pinned = identities(names)
    // A reported destination that is also another destination's ancestor is never replaceable.
    const targets = new Set(
      names.filter((name) => !names.some((other) => other !== name && within(other, name))),
    )
    const recheck = () => {
      unchanged(pinned)
      identities(resolve(paths))
    }
    return Object.assign(recheck, {
      mutation: (changedPaths: readonly string[]) => {
        recheck()
        // Capture resolved destinations before writing; a replacement link cannot enlarge this set.
        const destinations = resolve(changedPaths)
        const nonFiles = new Set(
          identities(destinations)
            .filter((entry) => !entry.file)
            .map((entry) => entry.name),
        )
        const changed = new Set(destinations.filter((name) => targets.has(name) && !nonFiles.has(name)))
        return () => {
          const retained = pinned.filter((entry) => !changed.has(entry.name))
          unchanged(retained)
          const current = identities(resolve(paths))
          const kept = new Set(retained.map((entry) => entry.name))
          pinned = [...retained, ...current.filter((entry) => !kept.has(entry.name))]
        }
      },
    })
  }

  async tool(
    tool: ToolDefinition,
    args: Record<string, unknown>,
    cwd: string,
  ): Promise<(() => void) | undefined> {
    const paths = await writtenPaths(tool, args, cwd)
    if (!toolTraits(tool)?.writesFiles && !tool.getWrittenPaths && paths === undefined) return undefined
    return this.check(cwd, paths)
  }
}
