import type { BackgroundJobHost, BackgroundJobInfo, BackgroundJobSession } from "@amira/api"
import type { Agent } from "../agent.ts"
import { scopeAdmission } from "../subagents/lifecycle.ts"

const ownedHosts = new Map<string, Set<BackgroundJobHost>>()
const fileKey = (file: string) => (process.platform === "win32" ? file.toLowerCase() : file)
const rootReaders = new WeakMap<BackgroundJobHost, (root: string) => BackgroundJobInfo[]>()

/** Host-private ownership query, retained even after the public session view is invalidated. */
export function registerJobRootReader(host: BackgroundJobHost, read: (root: string) => BackgroundJobInfo[]) {
  rootReaders.set(host, read)
}

/** Captured tool job views must use the same execution fence as their agent tree. */
export function scopedBackgroundJobs(
  jobs: BackgroundJobSession | undefined,
  agent: Agent,
  disposed: () => boolean,
): BackgroundJobSession | undefined {
  const { tree, session, backgroundJobsHost: host } = agent
  if (host && session?.header.owned) {
    // Ordinary release is best-effort. Preserve its root shutdown obligation for an inert
    // archive in another manager, scoped by canonical file rather than cross-home session id.
    const key = fileKey(session.file)
    const hosts = ownedHosts.get(key) ?? new Set<BackgroundJobHost>()
    hosts.add(host)
    ownedHosts.set(key, hosts)
  }
  if (!jobs || !tree) return jobs
  return new Proxy(jobs, {
    get(target, key) {
      if (key === "start")
        return (options: Parameters<BackgroundJobSession["start"]>[0]) => {
          if (disposed()) throw new Error("the background job session has ended")
          scopeAdmission(tree).checkExecution()
          return target.start(options)
        }
      const value = Reflect.get(target, key, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

export function hasOwnedBackgroundJobs(file: string): boolean {
  return ownedHosts.has(fileKey(file))
}

/** Disposal is best-effort; archival requires a fresh, root-scoped, confirmed shutdown. */
export async function drainOwnedBackgroundJobs(file: string, root: string): Promise<void> {
  const key = fileKey(file)
  for (const host of ownedHosts.get(key) ?? []) {
    const stopped = await host.closeRoot(root, 0)
    const remaining = rootReaders.get(host)?.(root) ?? []
    if ([...stopped, ...remaining].some((job) => !["exited", "stopped", "failed"].includes(job.status)))
      throw new Error("owned conversation background jobs have not confirmed shutdown; retry archive")
  }
  ownedHosts.delete(key)
}
