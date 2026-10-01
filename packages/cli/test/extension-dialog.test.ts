import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { createAi, createMockDialect } from "@amira/ai"
import type { AnyEvent } from "@amira/api"
import { type ActivePackages, readManifest } from "@amira/packages"
import { key } from "@amira/tui-kit"
import { Dialog } from "../../tui/src/dialog.ts"
import { plain } from "../../tui-kit/test/context.ts"
import { createSession } from "../src/session.ts"

for (const kind of ["relative file", "absolute file", "package", "scoped package"] as const) {
  test(`${kind} confirmation shows a short source label without changing diagnostics or cancellation`, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "amira-extension-dialog-"))
    let session: Awaited<ReturnType<typeof createSession>> | undefined
    try {
      const cwd = path.join(dir, "project")
      const packageName = kind === "scoped package" ? "@example/confirmations" : "confirmations"
      const isPackage = kind === "package" || kind === "scoped package"
      const extensionDir = path.join(kind === "relative file" ? cwd : dir, "nested", "extensions")
      mkdirSync(cwd, { recursive: true })
      mkdirSync(extensionDir, { recursive: true })
      const file = path.join(extensionDir, "confirmation.ts")
      writeFileSync(
        file,
        `export default (api) => {
          api.reportError("fixture diagnostic")
          for (const title of ["Continue?", "Continue again?"]) {
            void api.ui.confirm(title).then((answer) => {
              if (answer === undefined) api.reportError(title + " cancelled")
            })
          }
        }`,
      )
      // Multiple extension files preserve the package/file diagnostic identity.
      writeFileSync(path.join(extensionDir, "other.ts"), "export default () => {}")
      writeFileSync(
        path.join(extensionDir, "package.json"),
        JSON.stringify({
          name: packageName,
          version: "1.0.0",
          amira: { extensions: ["confirmation.ts", "other.ts"] },
        }),
      )
      const packages: ActivePackages = {
        packages: isPackage
          ? [
              {
                name: packageName,
                scope: "user",
                dir: extensionDir,
                entry: {
                  version: "1.0.0",
                  source: { type: "path", path: extensionDir },
                  pinned: {},
                  installedAt: "2026-01-01T00:00:00Z",
                },
                manifest: readManifest(extensionDir),
              },
            ]
          : [],
        problems: [],
        skipped: [],
      }
      const ai = createAi({
        dialects: [createMockDialect([])],
        providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
      })
      session = await createSession({
        model: "mock/m",
        cwd,
        extensions: isPackage ? [] : [file],
        packages,
        noBuiltins: true,
        ai,
      })
      const source = isPackage
        ? `${packageName}/confirmation.ts`
        : kind === "relative file"
          ? "nested/extensions/confirmation.ts"
          : file
      const label = isPackage ? packageName : "confirmation.ts"
      const [request, second] = session.host.ui.pending
      expect(request?.source).toBe(source)
      expect(second?.source).toBe(source)
      expect(session.startupEvents).toContainEqual(
        expect.objectContaining({
          type: "extension.error",
          data: expect.objectContaining({ source, error: expect.stringContaining("fixture diagnostic") }),
        }),
      )
      const dialog = new Dialog(request!, (answer) => session!.host.ui.respond(request!.requestId, answer))
      expect(dialog.render(120, plain)[0]).toBe(`┃ ? Continue? (${label})`)

      // A display name must never become the cancellation identity.
      session.host.ui.cancelAll(label)
      expect(session.host.ui.pending).toHaveLength(2)
      const events: AnyEvent[] = []
      session.agent.bus.subscribe((event) => {
        events.push(event)
      })
      dialog.handleInput(key("escape"))
      expect(session.host.ui.pending.map((r) => r.requestId)).toEqual([second!.requestId])
      expect(session.host.unload(source)).toBe(true)
      expect(session.host.ui.pending).toEqual([])
      await session.agent.bus.flush()
      expect(events.filter((e) => e.type === "ui.resolved").map((e) => e.data)).toEqual([
        { requestId: request!.requestId, cancelled: true },
        { requestId: second!.requestId, cancelled: true },
      ])
      expect(events.filter((e) => e.type === "extension.error").map((e) => e.data)).toEqual([
        expect.objectContaining({ source, error: expect.stringContaining("Continue? cancelled") }),
        expect.objectContaining({ source, error: expect.stringContaining("Continue again? cancelled") }),
      ])
    } finally {
      session?.host.unloadAll()
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })
}
