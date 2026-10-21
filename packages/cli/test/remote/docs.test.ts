import "../server/offline.ts"
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { parseRemoteCommand, REMOTE_USAGE, runRemoteCommand } from "../../src/remote/command.ts"

const root = path.resolve(import.meta.dir, "../../../..")
const guides = ["docs/remote-workspaces.md", "docs/zh/remote-workspaces.md", "docs/ja/remote-workspaces.md"]

test("remote help distinguishes local release downloads from offline bundles without setup", async () => {
  const output: string[] = []
  const unexpected = () => {
    throw new Error("Help must not probe, fetch artifacts, request consent or attach")
  }
  expect(
    await runRemoteCommand(["--help"], {
      localHome: "unused-for-help",
      release: { version: "test", buildId: "test" },
      publicKey: "unused-for-help",
      launcher: unexpected,
      artifacts: { load: unexpected },
      consent: unexpected,
      attach: unexpected,
      write: (text) => output.push(text),
    }),
  ).toBe(0)
  expect(output).toEqual([REMOTE_USAGE])
  expect(REMOTE_USAGE).toContain("downloaded locally")
  expect(REMOTE_USAGE).toContain("--bundle")
  expect(REMOTE_USAGE).not.toContain("requires a signed local server bundle")
})

test.each(guides)("%s setup examples use shipped remote options", (file) => {
  const markdown = readFileSync(path.join(root, file), "utf8")
  const commands = [...markdown.matchAll(/^amira remote (?:add|attach) .+$/gm)].map((match) => match[0])
  expect(commands).toHaveLength(7)
  for (const command of commands) {
    // These setup examples intentionally use single-line, unquoted argv, not shell programs.
    const options = parseRemoteCommand(command.split(/\s+/).slice(2))
    expect(["add", "attach"]).toContain(options.action)
  }
  for (const flag of ["--name", "--cwd", "--accept-install", "--remote-key", "--bundle"])
    expect(markdown).toContain(flag)
})
