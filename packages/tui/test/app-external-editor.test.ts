import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PromptHistory } from "../src/prompt-history.ts"
import { setup, waitFor } from "./app-harness.ts"

async function editWith(
  choice: "visual" | "editor" | "git" | "notepad",
  variables: { VISUAL?: string; EDITOR?: string },
  gitEditor = true,
  relative = false,
) {
  const dir = mkdtempSync(join(tmpdir(), "amira-editor-selection-"))
  const script = join(dir, "fake editor.ts")
  const command = (name: string) =>
    `"${process.execPath}" "${relative ? "fake editor.ts" : script}" ${name} --wait`
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(dir, "empty.gitconfig"),
    GIT_CONFIG_COUNT: "0",
    VISUAL: variables.VISUAL === "visual" ? command("visual") : variables.VISUAL,
    EDITOR: variables.EDITOR === "editor" ? command("editor") : variables.EDITOR,
    PATH: `${dir};${process.env.PATH ?? ""}`,
  }
  writeFileSync(env.GIT_CONFIG_GLOBAL, "")
  writeFileSync(
    script,
    'import { appendFileSync } from "node:fs"\n' +
      'if (process.argv[3] !== "--wait") process.exit(2)\n' +
      'appendFileSync(process.argv[4]!, " " + process.argv[2] + "\\n")\n',
  )
  // Shadow the Windows fallback: never start the real Notepad during a regression.
  writeFileSync(join(dir, "notepad.cmd"), `@"${process.execPath}" "${script}" notepad --wait %1\r\n`)
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", dir, ...args], { env, encoding: "utf8" })
    expect(result.status).toBe(0)
  }
  try {
    git("init", "--quiet")
    if (gitEditor) git("config", "core.editor", command("git"))
    const { terminal, live, exited } = await setup([], {
      cwd: dir,
      env,
      promptHistory: new PromptHistory(),
    })
    try {
      terminal.send("draft")
      await waitFor(() => live().includes("› draft"), "typed draft")
      terminal.send("\x07")
      await waitFor(
        () => /› draft (visual|editor|git|notepad)/.test(live()) || live().includes("Cannot start"),
        "external editor result",
      )
      expect(live()).toContain(`› draft ${choice}`)
    } finally {
      terminal.send("\x03\x03")
      await exited
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const windowsTest = process.platform === "win32" ? test : test.skip

windowsTest(
  "Ctrl+G: Windows prefers VISUAL over EDITOR and core.editor, preserving arguments",
  async () => {
    await editWith("visual", { VISUAL: "visual", EDITOR: "editor" })
  },
  60_000,
)

windowsTest(
  "Ctrl+G: Windows prefers EDITOR over core.editor when VISUAL is blank",
  async () => {
    await editWith("editor", { VISUAL: "  ", EDITOR: "editor" })
  },
  60_000,
)

windowsTest(
  "Ctrl+G: Windows uses the project's core.editor when VISUAL and EDITOR are blank",
  async () => {
    await editWith("git", { VISUAL: "  ", EDITOR: "\t" })
  },
  60_000,
)

windowsTest(
  "Ctrl+G: Windows resolves core.editor arguments relative to the project directory",
  async () => {
    await editWith("git", {}, true, true)
  },
  60_000,
)

windowsTest(
  "Ctrl+G: Windows falls back to Notepad when no editor is configured",
  async () => {
    await editWith("notepad", {}, false)
  },
  60_000,
)
