import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { Terminal } from "@xterm/headless"
import { trackProcessTree } from "../../packages/proc/src/index.ts"
import { copyExtensions } from "./extensions.ts"
import { encodeKeys } from "./keys.ts"
import { removeOwnedRoot, writeOwnedError } from "./ownership.ts"
import { armParentGuard, type ParentGuard } from "./parent-guard.ts"
import { createProvider, setupFixtures } from "./provider.ts"
import { renderScreen, screenAnsi, screenText } from "./render.ts"
import { checkout, positiveInteger, type SessionConfig, saveJson, type WalkRequest } from "./session.ts"
import { createShutdown } from "./shutdown.ts"

/** Deliberately do not inherit credentials, user extensions, terminal identity or Amira settings. */
function childEnvironment(home: string, amira: string, origin: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL"]) {
    if (process.env[key]) env[key] = process.env[key]!
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    AMIRA_HOME: amira,
    TMPDIR: path.join(home, "tmp"),
    TMP: path.join(home, "tmp"),
    TEMP: path.join(home, "tmp"),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    UI_WALK_PROVIDER_ORIGIN: origin,
  }
}

export async function runDaemon(config: SessionConfig): Promise<void> {
  const home = path.join(config.root, "home")
  const amira = path.join(home, ".amira")
  const cwd = path.join(config.root, "cwd")
  await Promise.all([
    mkdir(amira, { recursive: true }),
    mkdir(cwd),
    mkdir(path.join(home, "tmp"), { recursive: true }),
  ])
  const provider = await createProvider(config.scenario, config.token)
  let child: ReturnType<typeof Bun.spawn> | undefined
  let tree: ReturnType<typeof trackProcessTree> | undefined
  let server: ReturnType<typeof Bun.serve> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let exitTimer: ReturnType<typeof setTimeout> | undefined
  let parentGuard: ParentGuard | undefined
  let closing = false
  const screen = new Terminal({
    cols: config.cols,
    rows: config.rows,
    allowProposedApi: true,
    scrollback: 5000,
  })
  let writes = Promise.resolve()
  let lastOutput = Date.now()
  let lastCommand = Date.now()
  let outputBytes = 0
  let exitCode: number | null = null

  const shutdown = createShutdown({
    async stopResources() {
      closing = true
      if (timer) clearInterval(timer)
      if (exitTimer) clearTimeout(exitTimer)
      tree?.kill()
      // SIGKILL has been sent before the guardian is disarmed; no live child is left unguarded.
      const guardStopped = parentGuard?.stop()
      if (child) {
        let deadline: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            child.exited,
            new Promise<void>((resolve) => {
              deadline = setTimeout(resolve, 3000)
            }),
          ])
        } finally {
          if (deadline) clearTimeout(deadline)
        }
      }
      await guardStopped
      child?.terminal?.close()
      tree?.dispose()
      await provider.stop()
      screen.dispose()
    },
    removeFiles: () => removeOwnedRoot(config),
    stopServer(deferred) {
      if (deferred) setTimeout(() => server?.stop(true), 50)
      else server?.stop(true)
    },
    reportFailure(error) {
      console.error(`UI walk cleanup pending for ${config.root}: ${String(error)}`)
    },
    exhausted(error) {
      console.error(`UI walk exiting with leftover ${config.root}: ${String(error)}`)
      process.exit(1) // All resources have stopped; a filesystem lock cannot keep this daemon alive.
    },
  })

  function close(deferred = false, removeFiles = true): Promise<void> {
    return shutdown.close(deferred, removeFiles)
  }

  function closeInBackground() {
    void close().catch(() => {}) // createShutdown records the leftover and owns its bounded retries.
  }

  async function reportExit(): Promise<never> {
    const message = `Amira exited with code ${exitCode}\n${screenText(screen)}`
    try {
      await close(true)
    } catch (error) {
      throw new Error(`${message}\n${String(error)}`, { cause: error })
    }
    throw new Error(message)
  }

  try {
    const fixtures = await setupFixtures(amira, cwd, provider, config.theme)
    const extensions = await copyExtensions(amira, config.extensions)
    const posix = process.platform !== "win32"
    const env = childEnvironment(home, amira, provider.baseUrl.replace(/\/v1\/?$/, ""))
    child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        path.join(import.meta.dir, "offline.ts"),
        posix ? path.join(import.meta.dir, "child.ts") : path.join(checkout, "packages/cli/src/main.ts"),
        // Load the fixture last so canned tool overrides remain inert.
        ...extensions.flatMap((file) => ["--extension", file]),
        ...fixtures.args,
        ...config.args,
      ],
      {
        cwd,
        env,
        ipc: posix ? () => {} : undefined,
        // CREATE_NEW_PROCESS_GROUP bypasses ConPTY in Bun 1.4 on Windows. The Job Object
        // owns that tree; POSIX needs a detached process group for exact tree cleanup.
        detached: process.platform !== "win32",
        windowsHide: true,
        terminal: {
          cols: config.cols,
          rows: config.rows,
          data(_, data) {
            if (closing) return
            lastOutput = Date.now()
            outputBytes += data.byteLength
            // xterm's parser is asynchronous; snapshots always wait for its write callbacks.
            writes = writes.then(() => new Promise<void>((resolve) => screen.write(data, resolve)))
          },
        },
      },
    )
    tree = trackProcessTree(child, { killOnClose: true })
    // Terminal responses (DSR, DA, etc.) go back to the real application, not into its screen.
    screen.onData((data) => child?.terminal?.write(data))
    child.exited.then((code) => {
      exitCode = code
      if (!closing) exitTimer = setTimeout(closeInBackground, Math.min(5000, config.idleTimeout))
    })
    if (posix) {
      parentGuard = await armParentGuard(child, config.root, cwd, env)
      parentGuard.exited.then(() => {
        if (!closing) tree?.kill() // Never leave the application running without its guardian.
      })
    } else if (!tree.contained) {
      throw new Error("Cannot safely contain the Windows PTY child in a kill-on-close Job Object")
    }
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, closeInBackground)

    async function snapshot(): Promise<void> {
      // Include writes appended while a previous write callback was settling.
      let pending: Promise<void>
      do {
        pending = writes
        await pending
      } while (pending !== writes)
    }

    async function handle(body: WalkRequest): Promise<Response> {
      lastCommand = Date.now()
      if (body.command !== "stop" && exitCode !== null && !closing) await reportExit()
      if (body.command === "status") {
        return Response.json({
          pid: process.pid,
          childPid: child!.pid,
          cols: screen.cols,
          rows: screen.rows,
          exitCode,
        })
      }
      if (body.command === "stop") {
        await close(true)
        return new Response("stopped\n")
      }
      if (closing) throw new Error("Session is stopping")
      if (body.command === "keys") {
        const encoded = (body.keys ?? []).map((key) =>
          encodeKeys([key], screen.modes.applicationCursorKeysMode),
        )
        for (const input of encoded) {
          child!.terminal!.write(input)
          // A lone Escape needs the real input reader's 40ms ambiguity timeout. Joining
          // it to the next text token would turn that token's first character into Alt+key.
          if (input === "\x1b") await Bun.sleep(100)
        }
        lastOutput = Date.now()
        return new Response("ok\n")
      }
      if (body.command === "resize") {
        const cols = positiveInteger(body.cols!, "cols", 500)
        const rows = positiveInteger(body.rows!, "rows", 200)
        await snapshot()
        screen.resize(cols, rows)
        lastOutput = Date.now()
        child!.terminal!.resize(cols, rows)
        return new Response("ok\n")
      }
      if (body.command === "wait") {
        const timeout = positiveInteger(body.timeout ?? 30_000, "timeout")
        const idle = positiveInteger(body.idle ?? 300, "idle")
        const started = Date.now()
        const initialBytes = outputBytes
        while (Date.now() - started < timeout) {
          lastCommand = Date.now()
          await snapshot()
          if (exitCode !== null && !closing) await reportExit()
          if (closing) throw new Error("Session is stopping")
          if (
            body.text !== undefined
              ? screenText(screen, false).includes(body.text)
              : Date.now() - lastOutput >= idle
          ) {
            return new Response("ready\n")
          }
          await Bun.sleep(25)
        }
        throw new Error(`Wait timed out (${outputBytes - initialBytes} output bytes)\n${screenText(screen)}`)
      }
      await snapshot()
      if (body.command === "text") return new Response(screenText(screen))
      if (body.command === "ansi") return new Response(screenAnsi(screen))
      if (body.command === "shot") {
        return new Response(Buffer.from(await renderScreen(screen)), {
          headers: { "content-type": "image/png" },
        })
      }
      throw new Error(`Unknown command: ${body.command}`)
    }

    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 255,
      async fetch(req) {
        server!.timeout(req, 0) // A long --text wait must not be cut off by HTTP's idle timer.
        if (req.headers.get("authorization") !== `Bearer ${config.token}`)
          return new Response("Forbidden", { status: 403 })
        if (req.method !== "POST") return new Response("POST required", { status: 405 })
        try {
          const body: unknown = await req.json()
          if (!body || typeof body !== "object" || !("command" in body) || typeof body.command !== "string") {
            throw new Error("Expected a command object")
          }
          return await handle(body as WalkRequest)
        } catch (error) {
          return new Response(error instanceof Error ? error.message : String(error), { status: 400 })
        }
      },
    })
    timer = setInterval(
      () => {
        if (Date.now() - lastCommand >= config.idleTimeout) closeInBackground()
      },
      Math.min(1000, config.idleTimeout),
    )
    await saveJson(path.join(config.root, "address.json"), {
      generation: config.generation,
      name: config.name,
      root: config.root,
      token: config.token,
      port: server.port,
      pid: process.pid,
      childPid: child.pid,
    })
  } catch (error) {
    // Preserve this generation's config until the launcher has collected startup diagnostics.
    await close(false, false)
    throw error
  }
}

if (import.meta.main) {
  const root = process.argv[2]!
  let config: SessionConfig | undefined
  try {
    config = JSON.parse(await readFile(path.join(root, "config.json"), "utf8"))
    await runDaemon(config!)
  } catch (error) {
    if (config) {
      await writeOwnedError(config, error)
      const owner = config
      setTimeout(
        () =>
          void removeOwnedRoot(owner).catch((cleanupError) => {
            console.error(`UI walk startup cleanup pending for ${owner.root}: ${String(cleanupError)}`)
            process.exitCode = 1
          }),
        5000,
      )
    }
    process.exitCode = 1
  }
}
