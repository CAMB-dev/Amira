import { expect, test } from "bun:test"
import { SPAWN_TEST_TIMEOUT_MS } from "../../../scripts/spawn-test.ts"
import { externalEditor } from "../src/app/external-editor.ts"
import { boundSpawnSync } from "./spawn-fixture.ts"

test("VISUAL, then EDITOR, win over git and the platform default", () => {
  expect(externalEditor({ VISUAL: "code --wait", EDITOR: "vim" }, process.cwd())).toBe("code --wait")
  expect(externalEditor({ VISUAL: " ", EDITOR: "vim -f" }, process.cwd())).toBe("vim -f")
})

test(
  "a missing git working directory falls back without throwing",
  () => {
    const boundedSpawn = boundSpawnSync()
    try {
      const command = externalEditor(
        { GIT_CONFIG_GLOBAL: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1" },
        "/nonexistent-dir",
      )
      expect(typeof command).toBe("string")
      expect(command.length).toBeGreaterThan(0)
    } finally {
      boundedSpawn.mockRestore()
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)
