import { expect, test } from "bun:test"
import path from "node:path"
import { SPAWN_TEST_TIMEOUT_MS, stopSpawn, waitForSpawnExit, waitForSpawnWork } from "../spawn-test.ts"

test(
  "tooling preload blocks live HTTP before a request is made",
  async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        path.join(import.meta.dir, "offline.ts"),
        "-e",
        'try { await fetch("https://example.com/live"); process.exit(2) } catch (e) { console.log(String(e)) }',
      ],
      {
        env: { ...process.env, UI_WALK_PROVIDER_ORIGIN: "http://127.0.0.1:12345" },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    try {
      const [output, code] = await waitForSpawnWork(
        "child output",
        Promise.all([new Response(child.stdout).text(), waitForSpawnExit(child, "offline preload")]),
      )
      expect(code).toBe(0)
      expect(output).toContain("UI walk blocked outbound request: https://example.com")
    } finally {
      await stopSpawn(child)
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)
