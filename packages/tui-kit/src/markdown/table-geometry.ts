import type { Env } from "./blocks.ts"

/** Reserve a host's retained outer inset before wrapping table rows, never by cropping afterward. */
export function tableEnvironment(env: Env, table: object): Env {
  const width = env.tableWidth?.(table, env.width) ?? env.width
  if (width === env.width) return env
  const adjustment = width - env.width
  return {
    ...env,
    width,
    rowWidth: env.rowWidth ? () => Math.max(1, env.rowWidth!() + adjustment) : undefined,
    tableWidth: undefined,
  }
}
