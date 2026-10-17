import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  SPAWN_TEST_TIMEOUT_MS,
  stopSpawn,
  waitForSpawnExit,
  waitForSpawnWork,
} from "../../../scripts/spawn-test.ts"

for (const args of [[], ["--inline"], ["--fullscreen"]]) {
  test(
    `TERM=dumb exits nonzero with print-mode guidance (${args.join(" ") || "default"})`,
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "amira-dumb-terminal-"))
      const main = new URL("../../cli/src/main.ts", import.meta.url).href
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
process.argv = [process.execPath, "amira", ...${JSON.stringify(args)}];
await import(${JSON.stringify(main)});`,
        ],
        {
          cwd: directory,
          env: { ...process.env, TERM: "dumb", AMIRA_HOME: join(directory, "home") },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      try {
        const [output, error, code] = await waitForSpawnWork(
          "dumb terminal output and exit",
          Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            waitForSpawnExit(child, "dumb terminal rejection"),
          ]),
        )
        expect(code).not.toBe(0)
        expect(error).toContain('TERM=dumb cannot run the fullscreen UI; use amira -p "<prompt>"')
        expect(output).toBe("")
        expect(error).not.toContain("\x1b")
      } finally {
        await stopSpawn(child, "dumb terminal cleanup")
        rmSync(directory, { recursive: true, force: true })
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
}
