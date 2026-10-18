import { amiraHome } from "@amira/core"
import { defaultBuiltins } from "./session/builtin-profiles.ts"
import { createSession as create, type SessionOptions } from "./session-factory.ts"
import { loadThemeFiles } from "./theme-files.ts"

export * from "./session-factory.ts"

/** Local CLI defaults; the server imports the shared factory directly. */
export function createSession(opts: SessionOptions) {
  return create({
    ...opts,
    builtins: opts.builtins ?? defaultBuiltins,
    loadThemes:
      opts.loadThemes ??
      ((host, packages, bus) => {
        const { notices } = loadThemeFiles(host.themes, {
          home: amiraHome(),
          cwd: opts.cwd,
          packageThemes: packages?.packages.flatMap((pkg) => pkg.manifest.themes ?? []),
        })
        for (const text of notices) {
          bus.emit("extension.notice", { source: "themes", text, level: "warning" }, { sessionId: "host" })
        }
      }),
  })
}
