import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { userMessage } from "@amira/ai"
import { listSessions, SessionStore } from "@amira/core"
import {
  SPAWN_TEST_TIMEOUT_MS,
  stopSpawn,
  waitForSpawnExit,
  waitForSpawnWork,
} from "../../../scripts/spawn-test.ts"
import { projectKey } from "../../core/src/session-project.ts"
import { formatSessionList } from "../src/resume.ts"

async function resume(args: string[], tty: boolean) {
  const home = mkdtempSync(path.join(os.tmpdir(), "amira-resume-dumb-"))
  const cwd = path.join(home, "project")
  mkdirSync(cwd)
  const dir = path.join(home, "sessions", projectKey(cwd))
  const store = SessionStore.create({ cwd, dir })
  store.appendMessage(userMessage("keep this session"))
  const expectedList = `${formatSessionList(listSessions(cwd, dir))}\n`
  const preload = path.join(home, "streams.ts")
  // Only replace the terminal boundary: readline gets Enter when it starts reading.
  writeFileSync(
    preload,
    `import { Readable } from "node:stream"
const input = new Readable({ read() { this.push("\\n"); this.push(null) } })
Object.assign(input, { isTTY: ${tty}, setRawMode() {} })
Object.defineProperty(process, "stdin", { value: input })
Object.defineProperty(process.stdout, "isTTY", { value: ${tty} })
globalThis.fetch = () => { throw new Error("unexpected network request") }
`,
  )
  try {
    const child = Bun.spawn(
      [process.execPath, "--preload", preload, path.join(import.meta.dir, "../src/main.ts"), ...args],
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          AMIRA_HOME: home,
          HOME: home,
          USERPROFILE: home,
          AMIRA_MODEL: "",
          TERM: "dumb",
          TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      },
    )
    try {
      const [out, err, code] = await waitForSpawnWork(
        "dumb-terminal resume",
        Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          waitForSpawnExit(child, "dumb-terminal resume"),
        ]),
      )
      return { out, err, code, expectedList }
    } finally {
      await stopSpawn(child, "dumb-terminal resume cleanup")
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

for (const args of [
  ["-r", "--", "hello"],
  ["--resume=", "hello"],
]) {
  test(
    `${args.join(" ")} rejects TERM=dumb before the numbered resume picker`,
    async () => {
      const { out, err, code } = await resume(args, true)
      expect({ code, out, err }).toMatchObject({ code: 2 })
      expect(err).toContain("TERM=dumb")
      expect(err).toContain('amira -p "<prompt>"')
      expect(out).toBe("")
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
}

for (const args of [
  ["-r", "--", "hello"],
  ["-p", "-r"],
]) {
  test(
    `${args.join(" ")} preserves noninteractive session listing with TERM=dumb`,
    async () => {
      const { out, err, code, expectedList } = await resume(args, false)
      expect({ code, err, out }).toEqual({ code: 0, err: "", out: expectedList })
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
}
