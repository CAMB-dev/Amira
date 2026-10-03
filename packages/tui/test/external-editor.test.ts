import { expect, test } from "bun:test"
import { externalEditor } from "../src/app/external-editor.ts"

test("VISUAL, then EDITOR, win over git and the platform default", () => {
  expect(externalEditor({ VISUAL: "code --wait", EDITOR: "vim" }, process.cwd())).toBe("code --wait")
  expect(externalEditor({ VISUAL: " ", EDITOR: "vim -f" }, process.cwd())).toBe("vim -f")
})

test("a missing git working directory falls back without throwing", () => {
  const command = externalEditor(
    { GIT_CONFIG_GLOBAL: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1" },
    "/nonexistent-dir",
  )
  expect(typeof command).toBe("string")
  expect(command.length).toBeGreaterThan(0)
})
