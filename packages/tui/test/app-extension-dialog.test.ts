import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { closeImageApp, setup, waitFor } from "./app-harness.ts"

for (const mode of ["fullscreen", "inline"] as const) {
  test(`${mode}: workflow confirmation labels the extension without its full source path`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "amira-workflow-dialog-"))
    const file = join(dir, "index.ts")
    writeFileSync(
      file,
      `export default (api) => {
        api.registerCommand({
          name: "workflow",
          description: "Start a workflow",
          async run() {
            await api.ui.confirm('Start workflow "repair"?', "Repair the build")
          },
        })
      }`,
    )
    const s = await setup([], { commands: [], settings: { mode }, cols: 100 })
    try {
      expect(await s.host.loadFile(file, { name: "workflow" })).toBe(true)
      s.terminal.send("/workflow repair\r")
      await waitFor(() => s.live().includes('Start workflow "repair"?'), "workflow confirmation")
      expect(s.live()).toContain('? Start workflow "repair"? (workflow)')
      expect(s.live()).not.toContain(dir)
      expect(s.live()).not.toContain("index.ts")
      // The short label is presentation only: unloading still cancels by the source path.
      expect(s.host.ui.pending[0]?.source).toBe(file)
      expect(s.host.unload(file)).toBe(true)
      await waitFor(() => !s.live().includes('Start workflow "repair"?'), "confirmation cancelled")
      expect(s.host.ui.pending).toEqual([])
    } finally {
      await closeImageApp(s)
      s.host.unloadAll()
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })
}
