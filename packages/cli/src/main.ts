#!/usr/bin/env bun
import type { AnyEvent } from "@amira/api"
import { type Agent, activePackages, listSessions, SessionStore, trackWorkspace } from "@amira/core"
import { runInteractive } from "@amira/tui"
import pkg from "../package.json" with { type: "json" }
import { parseCliArgs, USAGE, UsageError } from "./args.ts"
import { resolveConfig } from "./config.ts"
import { createCommandHost } from "./control.ts"
import { runExtCommand } from "./ext-command.ts"
import { runPackageCommand } from "./package-command.ts"
import { runPrint } from "./print.ts"
import { runProviderCommand } from "./provider-command.ts"
import { chooseStore, formatSessionList, pickSession } from "./resume.ts"
import { runRpc } from "./rpc.ts"
import { rpcSchema } from "./rpc-schema.ts"
import { createSession } from "./session.ts"

async function main(argv: string[]): Promise<number> {
  try {
    return await run(argv)
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    process.stderr.write(`amira: ${err.message}\n\nRun amira --help for usage.\n`)
    return 2
  }
}

async function run(argv: string[]): Promise<number> {
  const io = {
    stdout: (s: string) => void process.stdout.write(s),
    stderr: (s: string) => void process.stderr.write(s),
  }
  if (argv[0] === "provider") return runProviderCommand(argv.slice(1), io)
  if (argv[0] === "ext") return runExtCommand(argv.slice(1), io)
  const fromPackage = await runPackageCommand(argv, io)
  if (fromPackage !== undefined) return fromPackage
  const args = parseCliArgs(argv)
  if (args.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (args.version) {
    process.stdout.write(`${pkg.version}\n`)
    return 0
  }
  if (args.rpcSchema) {
    process.stdout.write(`${JSON.stringify(rpcSchema(), null, 2)}\n`)
    return 0
  }
  if (args.shell === "powershell" && process.platform !== "win32") {
    throw new UsageError("--shell powershell is only available on Windows")
  }
  const config = resolveConfig(args)
  // The interactive UI covers stderr, so there the warnings are shown as startup events.
  if (args.print) for (const w of config.warnings) process.stderr.write(`amira: warning: ${w}\n`)
  const modelRef = config.settings.model
  const requireModel = (): string => {
    if (modelRef) return modelRef
    throw new UsageError(
      'no model selected. Pass --model provider/model, set AMIRA_MODEL or set "model" in settings.json.',
    )
  }
  const interactive = !args.print && !args.rpc
  let choice: { store: SessionStore; resumed: boolean } | undefined
  if (args.resume === "") {
    const sessions = listSessions(args.cwd)
    if (!sessions.length) {
      process.stderr.write(`amira: no sessions in ${args.cwd}\n`)
      return 1
    }
    if (!interactive || !(process.stdin.isTTY && process.stdout.isTTY)) {
      process.stdout.write(`${formatSessionList(sessions)}\n`)
      return 0
    }
    requireModel()
    const picked = await pickSession(sessions)
    if (!picked) return 0
    choice = { store: SessionStore.open(picked.file), resumed: true }
  }
  const model = requireModel()
  if (interactive && !(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new UsageError("the interactive UI needs a terminal; use --print for pipes and scripts")
  }

  // Where failures of event subscribers go: stderr in print mode, the UI in interactive mode.
  let agentRef: Agent | undefined
  const onSubscriberError = (err: unknown, ev: AnyEvent) => {
    const error = `handler for ${ev.type} failed: ${err instanceof Error ? err.message : String(err)}`
    if (interactive && agentRef && ev.type !== "extension.error") {
      agentRef.bus.emit("extension.error", { source: "event subscriber", error }, { sessionId: "host" })
    } else if (!interactive) {
      process.stderr.write(`amira: ${error}\n`)
    }
  }

  choice ??= chooseStore({
    cwd: args.cwd,
    continue: args.continue,
    ...(args.resume ? { resume: args.resume } : {}),
  })
  const { store, resumed } = choice
  const session = await createSession({
    model,
    cwd: args.cwd,
    extensions: args.extensions,
    packages: activePackages({ cwd: args.cwd }),
    noBuiltins: args.noBuiltins,
    store,
    disabledTools: config.disabledTools,
    requestedDisabled: config.requestedDisabled,
    settings: config.settings,
    providers: config.providers,
    apiKeys: config.apiKeys,
    ...(args.print ? {} : { warnings: config.warnings }),
    onSubscriberError,
  })
  const { agent, host, startupEvents, catalogRefresh, ai } = session
  agentRef = agent

  // Announce the session once the frontend listens, then fill in git facts in the background.
  let stopWorkspace = () => {}
  const announce = (a: Agent, reason: "startup" | "resume" | "clear") => {
    const s = a.session
    a.start(reason, s ? { sessionFile: s.file, resume: ["amira", "--resume", s.id] } : {})
    stopWorkspace()
    stopWorkspace = trackWorkspace(a.bus, a.sessionId, a.cwd)
  }
  // Slash commands own which agent is active: /clear and /resume (and rpc session.resume) switch it.
  const commands = createCommandHost({
    session,
    cwd: args.cwd,
    shell: config.shell,
    disabled: config.requestedDisabled.names,
    ...(config.settings.commandAliases ? { aliases: config.settings.commandAliases } : {}),
    announce: (next, reason) => {
      agentRef = next
      announce(next, reason)
    },
  })
  const onReady = () => announce(agent, resumed ? "resume" : "startup")
  try {
    if (args.rpc) {
      return await runRpc({ agent, ai, ui: host.ui, commands }, { pending: startupEvents, onReady })
    }
    if (!interactive) {
      return await runPrint(agent, args.prompt ?? "", args.json, {
        pending: startupEvents,
        onReady,
        ui: host.ui,
        commands,
      })
    }
    return await runInteractive({
      agent,
      status: host.status,
      ui: host.ui,
      commands,
      startupEvents,
      onReady,
      ...(args.prompt ? { initialPrompt: args.prompt } : {}),
    })
  } finally {
    stopWorkspace()
    const last = agentRef ?? agent
    last.cancelNoticeRetry()
    last.bus.emit("session.end", { reason: "exit" }, { sessionId: last.sessionId })
    // Sub-agents still running (in the background) end with the session; give them a moment
    // to stop cleanly. Give a catalog download a moment to reach the cache, so short runs still fill it.
    session.tree.abortAll("the session ended")
    const children = Promise.all(session.tree.children.map((c) => c.result()))
    await Promise.race([Promise.all([children, catalogRefresh]), Bun.sleep(5000)])
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`amira: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  },
)
