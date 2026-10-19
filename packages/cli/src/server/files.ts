import { randomUUID } from "node:crypto"
import { constants, realpathSync, statSync } from "node:fs"
import { open, realpath, stat } from "node:fs/promises"
import { basename, isAbsolute, relative, resolve } from "node:path"
import { type FrontendExecuteOptions, FrontendOperationError, streamProjectFiles } from "@amira/core"
import type { FrontendScopeRoot } from "../../../core/src/frontend/scope-root.ts"
import { fileOperationSchemas, MAX_IMAGE_BYTES, type OperationsFromSchemas } from "../remote/schema/files.ts"
import { failure, type OperationHandlers, operationGuard, validate } from "./file-support.ts"
import { checkedImage } from "./images.ts"

export type ServerFileOperations = OperationsFromSchemas<typeof fileOperationSchemas>
export interface FileScope {
  cwd: string
  /** Optional authority already pinned by the host at actor creation, never resolved by a request. */
  root?: FrontendScopeRoot
}
type Stream = (
  cwd: string,
  emit: (paths: string[]) => void,
  options: { limit: number; timeoutMs: number; signal: AbortSignal },
) => Promise<boolean>
export interface ServerFileOptions {
  generation: () => number
  /** Missing/unknown/released child scope must throw or return undefined. No caller-supplied cwd. */
  resolveScope: (scope?: string) => FileScope | undefined | Promise<FileScope | undefined>
  /** A store-verified, pinned directory; never derive authority by resolving a supplied path. */
  resolveArtifact?: (
    id: string,
    scope?: string,
  ) => { path: string; root: string } | undefined | Promise<{ path: string; root: string } | undefined>
  stream?: Stream
  maxFiles?: number
  maxListingBytes?: number
}
type Listing = {
  generation: string
  session: number
  cwd: string
  abort: AbortController
  entries: string[]
  partial: boolean
  ready: Promise<void>
}

function inside(root: string, file: string) {
  const rel = relative(root, file)
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../"))
}

/** Immutable, finite listing generations and authorized bounded reads. No generic FS surface. */
export function createServerFileOperations(
  deps: ServerFileOptions,
): OperationHandlers<ServerFileOperations> & {
  /** Host-only: establish before exposing a workspace or binding a conversation, never on file access. */
  establishScope(cwd: string, scope?: string, root?: FrontendScopeRoot): void
  /** Cancels listing resources; authority stays pinned for this service's lifetime, including session switches. */
  dispose(): void
} {
  const listings = new Map<string, Listing>()
  const scopes = new Map<string, { cwd: string; ino: number; dev: number }>()
  const maxFiles = deps.maxFiles ?? 250_000
  const maxBytes = deps.maxListingBytes ?? 16 * 1024 * 1024
  if (
    !Number.isSafeInteger(maxFiles) ||
    maxFiles < 1 ||
    maxFiles > 250_000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 16 * 1024 * 1024
  )
    throw new RangeError("Invalid file listing bounds")
  const key = (scope?: string) => scope ?? ""
  const drop = (scope: string) => {
    listings.get(scope)?.abort.abort()
    listings.delete(scope)
  }
  const getScope = async (scope: string | undefined, check: () => void) => {
    const found = await deps.resolveScope(scope)
    check()
    if (!found) failure("Unknown file scope")
    const pinned = scopes.get(key(scope)) ?? found.root
    if (!pinned) failure("File scope has not been established")
    const cwd = await realpath(found.cwd)
    const info = await stat(cwd)
    check()
    if (cwd !== pinned.cwd || !info.isDirectory() || info.ino !== pinned.ino || info.dev !== pinned.dev)
      failure("Authorized file root changed")
    return { cwd }
  }
  const page = async (
    params: ServerFileOperations["files.list"]["params"],
    options?: FrontendExecuteOptions,
    refresh = false,
  ) => {
    const check = operationGuard(deps.generation, options)
    const scope = await getScope(params.scope, check)
    const scopeKey = key(params.scope)
    if (refresh) drop(scopeKey)
    let listing = listings.get(scopeKey)
    if (listing && (listing.session !== deps.generation() || listing.cwd !== scope.cwd)) {
      drop(scopeKey)
      listing = undefined
    }
    let offset = 0
    if (params.cursor) {
      const [generation, position] = params.cursor.split(":")
      offset = Number(position)
      if (
        params.cursor.split(":").length !== 2 ||
        !listing ||
        listing.generation !== generation ||
        !/^\d+$/.test(position ?? "") ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > listing.entries.length
      )
        throw new FrontendOperationError("stale_operation", "The file listing expired")
    }
    if (!listing) {
      if (listings.size >= 8) drop(listings.keys().next().value!)
      const current: Listing = {
        generation: randomUUID(),
        session: deps.generation(),
        cwd: scope.cwd,
        abort: new AbortController(),
        entries: [],
        partial: false,
        ready: Promise.resolve(),
      }
      listing = current
      listings.set(scopeKey, current)
      const seen = new Set<string>()
      let bytes = 0
      current.ready = (async () => {
        const complete = await (deps.stream ?? streamProjectFiles)(
          scope.cwd,
          (paths) => {
            if (current.abort.signal.aborted || current.session !== deps.generation()) return
            for (const path of paths) {
              if (seen.has(path)) continue
              const size = Buffer.byteLength(path)
              if (current.entries.length >= maxFiles || bytes + size > maxBytes) {
                current.partial = true
                current.abort.abort()
                break
              }
              // Ignore malformed/escaping paths even if a custom source supplies them.
              if (
                !path ||
                path.includes("\u0000") ||
                isAbsolute(path) ||
                !inside(scope.cwd, resolve(scope.cwd, path))
              )
                continue
              seen.add(path)
              bytes += size
              current.entries.push(path)
            }
          },
          { limit: maxFiles + 1, timeoutMs: 15_000, signal: current.abort.signal },
        )
        current.partial ||= !complete
      })()
      // Install rejection handling immediately, including when a refresh overtakes this request.
      current.ready.catch(() => dropIfCurrent())
      const dropIfCurrent = () => {
        if (listings.get(scopeKey) === current) drop(scopeKey)
      }
    }
    const captured = listing
    const abort = () => {
      if (listings.get(scopeKey) === captured) drop(scopeKey)
    }
    options?.signal?.addEventListener("abort", abort, { once: true })
    if (options?.signal?.aborted) abort()
    try {
      await captured.ready
      await getScope(params.scope, check)
      check()
      if (listings.get(scopeKey) !== captured)
        throw new FrontendOperationError("stale_operation", "The file listing was replaced or cancelled")
      const end = Math.min(offset + (params.limit ?? 100), captured.entries.length)
      return {
        generation: captured.generation,
        entries: captured.entries.slice(offset, end),
        partial: captured.partial,
        ...(end < captured.entries.length ? { nextCursor: `${captured.generation}:${end}` } : {}),
      }
    } finally {
      options?.signal?.removeEventListener("abort", abort)
    }
  }
  const read = async (path: string, roots: string[], check: () => void) => {
    const canonical = await realpath(path)
    const allowed = await Promise.all(
      roots.map(async (root) => {
        const pinned = await realpath(root)
        if (pinned !== resolve(root)) failure("Authorized file root changed")
        return pinned
      }),
    )
    check()
    if (!allowed.some((root) => inside(root, canonical))) failure("File is outside the authorized scope")
    const initial = await stat(canonical)
    check()
    if (!initial.isFile() || initial.size > MAX_IMAGE_BYTES) failure("File must be at most 5 MiB")
    const handle = await open(
      canonical,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    )
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size < 1 || info.size > MAX_IMAGE_BYTES)
        failure("File must be at most 5 MiB")
      const after = await realpath(path)
      const current = await stat(after)
      check()
      if (
        after !== canonical ||
        !allowed.some((root) => inside(root, after)) ||
        info.ino !== current.ino ||
        info.dev !== current.dev
      )
        failure("File changed during authorization")
      const bytes = Buffer.alloc(info.size + 1)
      let length = 0
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length)
        check()
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      if (length !== info.size) failure("File changed during read")
      return { name: basename(canonical), bytes: bytes.subarray(0, length) }
    } finally {
      await handle.close()
    }
  }
  const handlers: OperationHandlers<ServerFileOperations> = {
    "files.list": (params, options) => page(params, options),
    "files.refresh": (params, options) => page(params, options, true),
    "files.cancel": async ({ scope, generation }, options) => {
      const check = operationGuard(deps.generation, options)
      await getScope(scope, check)
      const listing = listings.get(key(scope))
      if (!listing || listing.generation !== generation) return { cancelled: false }
      drop(key(scope))
      return { cancelled: true }
    },
    "images.read": async ({ scope, path }, options) => {
      const check = operationGuard(deps.generation, options)
      const { cwd } = await getScope(scope, check)
      const image = await read(resolve(cwd, path), [cwd], check)
      await getScope(scope, check)
      check()
      return checkedImage(image.bytes, image.name)
    },
    "artifacts.read": async ({ scope, id }, options) => {
      const check = operationGuard(deps.generation, options)
      await getScope(scope, check)
      const owned = await deps.resolveArtifact?.(id, scope)
      check()
      if (!owned) failure("Unknown artifact")
      const artifact = await read(owned.path, [owned.root], check)
      await getScope(scope, check)
      check()
      return { name: artifact.name, data: artifact.bytes.toString("base64"), bytes: artifact.bytes.length }
    },
  }
  // Validation also protects direct host callers, not just the wire decoder.
  for (const operation of Object.keys(handlers) as (keyof ServerFileOperations)[]) {
    const handler = handlers[operation]
    Object.assign(handlers, {
      [operation]: async (params: never, options?: FrontendExecuteOptions) => {
        validate(fileOperationSchemas[operation].params, params)
        return handler(params, options)
      },
    })
  }
  return Object.assign(handlers, {
    establishScope: (cwd: string, scope?: string, root?: FrontendScopeRoot) => {
      const canonical = realpathSync(cwd)
      const info = statSync(canonical)
      const pinned = scopes.get(key(scope))
      if (
        !info.isDirectory() ||
        [pinned, root].some(
          (pin) => pin && (canonical !== pin.cwd || info.ino !== pin.ino || info.dev !== pin.dev),
        )
      )
        failure("Authorized file root changed")
      scopes.set(key(scope), { cwd: canonical, ino: info.ino, dev: info.dev })
    },
    dispose: () => {
      for (const scope of listings.keys()) drop(scope)
    },
  })
}
