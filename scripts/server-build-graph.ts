import type { BunPlugin } from "bun"

/** Run on the resolved runtime graph, not source text (type-only UI imports are harmless). */
export function assertServerModule(file: string) {
  const normalized = file.replaceAll("\\", "/")
  if (
    /(?:^|\/)packages\/tui(?:-kit)?(?:\/|$)/.test(normalized) ||
    /(?:^|\/)packages\/cli\/themes(?:\/|$)/.test(normalized) ||
    /(?:^|\/)packages\/cli\/src\/(?:main|print|print-markdown)\.ts$/.test(normalized) ||
    /^@amira\/tui(?:-kit)?(?:\/|$)/.test(normalized)
  ) {
    throw new Error(`Forbidden server dependency: ${file}`)
  }
}

export function serverOnlyGraph(): BunPlugin {
  return {
    name: "amira-server-only",
    setup(build) {
      build.onResolve({ filter: /^@amira\/tui/ }, (args) => {
        assertServerModule(args.path)
        return undefined
      })
      build.onLoad({ filter: /./ }, (args) => {
        assertServerModule(args.path)
        return undefined
      })
    },
  }
}
