import "./native-smoke-fixture.ts"
import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { runInteractive } from "@amira/tui"
import { FakeTerminal } from "@amira/tui-kit"
import { waitForSpawnCondition, waitForSpawnWork } from "../../../../scripts/spawn-test.ts"
import { attachRemoteUi } from "../../src/remote/attach-ui.ts"
import type { RemoteAttachContext } from "../../src/remote/command.ts"
import type { SshSession } from "../../src/remote/ssh.ts"
import { smokeAnswer, smokePrompt, smokeRelease } from "./native-smoke-fixture.ts"

const [workspace, report] = process.argv.slice(2)
assert(workspace && report)
// The test's fake SSH launcher owns both children and joins their local spawn pipes.
// No ssh executable, shell, socket, daemon discovery or GUI is involved.
const ended = Promise.withResolvers<number>()
const session: SshSession = {
  input: process.stdin,
  write: (bytes) =>
    new Promise<void>((resolve, reject) => {
      process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()))
    }),
  async end() {
    process.stdout.end()
  },
  close() {
    process.stdin.destroy()
    ended.resolve(0)
  },
  exited: ended.promise,
  stderr: () => "",
}
let opened = 0
let validated = 0
const context: RemoteAttachContext = {
  host: "native-fake-ssh",
  workspace,
  installedRelease: smokeRelease,
  async open() {
    assert.equal(++opened, 1, "unexpected reconnect")
    return session
  },
  validateWelcome(welcome) {
    assert.deepEqual({ ...welcome.release }, smokeRelease)
    assert.equal(welcome.workspace, workspace)
    validated++
    return { replacementPending: false }
  },
  async connect() {
    throw new Error("attachRemoteUi must create its actual RemoteAgentPort")
  },
}
const terminal = new FakeTerminal(100, 30)
try {
  const code = await attachRemoteUi(context, {
    terminal,
    async interactive(options) {
      assert.equal(options.agent, undefined, "remote UI must not receive a local Agent")
      const frontend = options.frontend
      assert(frontend)
      assert(frontend.subscribeEvents)
      assert.equal(frontend.quitBehavior, "detach")
      assert.equal(frontend.connection, "connected")
      assert.equal(frontend.snapshot.state.cwd, workspace)
      assert.equal(frontend.snapshot.state.model.provider, "mock")
      assert.equal("prompt" in frontend, false)
      const initial = frontend.snapshot
      assert(Object.isFrozen(initial))
      assert.equal(initial.transcript.messages.length, 0)
      let messageEnded = false
      const off = frontend.subscribeEvents((event) => {
        if (event.type === "message.end") messageEnded = true
      })
      let quit = () => {}
      const exited = runInteractive({
        ...options,
        setup: async () => ({
          capabilities: {
            win32InputMode: false,
            kittyKeyboard: true,
            synchronizedOutput: false,
            shiftEnter: true,
          },
          leftoverInput: "",
        }),
        env: { ...process.env, TERM_PROGRAM: "WezTerm" },
        subscribeFrontendEffects(listener) {
          quit = () => listener({ kind: "detach" })
          return options.subscribeFrontendEffects!(listener)
        },
      })
      try {
        await waitForSpawnCondition("native frontend-only composer", () =>
          terminal.output.includes("Message Amira"),
        )
        assert(terminal.output.includes("Remote connected"))
        terminal.send(`${smokePrompt}\r`)
        await waitForSpawnCondition(
          "native remote answer",
          () =>
            messageEnded &&
            frontend.snapshot.transcript.messages.length === 2 &&
            terminal.output.includes(smokeAnswer),
        )
        assert(JSON.stringify(frontend.snapshot.transcript).includes(smokePrompt))
        assert(JSON.stringify(frontend.snapshot.transcript).includes(smokeAnswer))
        assert.equal(initial.transcript.messages.length, 0, "cached snapshots must remain immutable")
      } finally {
        off()
        quit()
        assert.equal(await waitForSpawnWork("native frontend-only quit", exited), 0)
      }
      return 0
    },
  })
  assert.equal(code, 0)
  assert.equal(opened, 1)
  assert.equal(validated, 1)
  await writeFile(
    report,
    JSON.stringify({ code, opened, validated, frontendOnly: true, renderedAnswer: true }),
  )
} finally {
  session.close()
  await session.exited
}
