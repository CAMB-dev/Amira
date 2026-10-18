import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { constants, tmpdir } from "node:os"
import path from "node:path"
import { modes } from "@amira/tui-kit"

const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]
if (process.platform === "win32") signals.push("SIGBREAK")
for (const { signal, printing } of [
  ...signals.map((signal) => ({ signal, printing: false })),
  { signal: "SIGINT" as const, printing: true },
]) {
  test(`background ${signal}${printing ? " in print mode" : ""} drains a renamed executable before restoring and exiting`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "amira-update-signal-"))
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        path.join(import.meta.dir, "../../core/test/file-lock-worker-preload.ts"),
        path.join(import.meta.dir, "signal-lifecycle-worker.ts"),
        root,
        signal,
        printing ? "print" : "tui",
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    )
    try {
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
      expect({ code, stderr }).toEqual({ code: 128 + constants.signals[signal]!, stderr: "" })
      expect(await readFile(path.join(root, "bin", "amira.exe"), "utf8")).toBe("1.2.4")
      const events = (await readFile(path.join(root, "events"), "utf8")).trim().split("\n")
      expect(events).toEqual([
        "copy.wait",
        ...(printing ? ["print.abort", "print.first.returned"] : []),
        "stop.start",
        "signal.returned",
        "copy.done",
        "stop.done",
        "terminal.restore",
        "terminal.transcript",
        "exit",
      ])
      const output = await readFile(path.join(root, "terminal"), "utf8")
      const transcript = "FULLSCREEN_EMERGENCY_TRANSCRIPT\r\n"
      expect(output.split(transcript)).toHaveLength(2)
      expect(output).toEndWith(
        `${modes.altScreen.off}${modes.bracketedPaste.off}\x1b[0m\x1b[?25h${transcript}`,
      )
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
}
