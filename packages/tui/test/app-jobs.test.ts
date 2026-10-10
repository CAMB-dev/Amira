import { expect, test } from "bun:test"
import { type JobEvent, JobRegistry } from "@amira/proc"
import { registerJobs } from "../../../extensions/builtin-tools/src/index.ts"
import { setup, waitFor } from "./app-harness.ts"

/** Background jobs over fake processes: what the panel, /jobs and the notices show. */
function fakeJobs() {
  const procs: { emit: (e: JobEvent) => void; stops: number[] }[] = []
  const registry = new JobRegistry({
    start: (_spec, onEvent) => {
      const p = { emit: onEvent, stops: [] as number[] }
      procs.push(p)
      // A stop ends it at once, as a killed process would.
      return {
        stop: (g: number) => {
          p.stops.push(g)
          setTimeout(() => onEvent({ type: "exit", code: null, signal: null }), 0)
        },
      }
    },
  })
  const start = (command: string, output: string) => {
    const job = registry.start({ command, argv: [command], cwd: "/work/proj" })
    const p = procs.at(-1)!
    p.emit({ type: "spawned", pid: 4000 + procs.length, contained: true })
    if (output) p.emit({ type: "output", data: output })
    return { job, proc: p }
  }
  return { registry, procs, start }
}

for (const mode of ["inline", "fullscreen"] as const) {
  for (const cols of [120, 60]) {
    test(`background jobs show in a live panel above the activity line (${mode}, ${cols} columns)`, async () => {
      const jobs = fakeJobs()
      jobs.start("npm run dev", "> vite\n  VITE ready in 300 ms\n  Local: http://localhost:5173/\n")
      jobs.start(
        "bun test --watch --coverage packages/proc packages/tui extensions/builtin-tools",
        "12 pass\n",
      )
      const { terminal, live, exited } = await setup([], {
        cols,
        rows: 24,
        settings: { mode },
        extensions: [(api) => registerJobs(api, jobs.registry)],
      })
      await waitFor(() => live().includes("2 background jobs running · /jobs to see or stop"), "the panel")
      const lines = screenLines(live())
      const head = lines.findIndex((l) => l.includes("2 background jobs running"))
      const rows = lines.slice(head + 1, head + 3)
      expect(rows[0]).toStartWith("● job1 0s · npm run dev · Local: http://localhost:5173/")
      expect(rows[1]).toStartWith("● job2 0s · bun test --watch")
      // Long rows are cut to the width, never wrapped; the id and time come first.
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(cols)
      // Narrow, the command gives way first, so the last line of output still shows.
      if (cols === 120) expect(rows[1]).toContain("· 12 pass")
      else expect(rows[1]).toBe("● job2 0s · bun test --watch --cove… · 12 pass")
      // The panel sits above the input box.
      expect(head).toBeLessThan(lines.findIndex((l) => l.startsWith("╭")))
      // Folded (Ctrl+T), only the summary stays.
      terminal.send("\x14")
      await waitFor(() => !live().includes("● job1"), "the folded panel")
      expect(live()).toContain("2 background jobs running · /jobs to see or stop")
      // Stopped jobs leave the panel; with none running it goes.
      await jobs.registry.stopAll()
      await waitFor(() => !live().includes("background job"), "the panel to go")
      terminal.send("\x03")
      await exited
    })
  }
}

/** The screen's rows without their trailing blanks. */
function screenLines(text: string): string[] {
  return text.split("\n").map((l) => l.trimEnd())
}

for (const mode of ["inline", "fullscreen"] as const) {
  test(`/jobs lists the jobs; x stops one, Enter opens its live output (${mode})`, async () => {
    const jobs = fakeJobs()
    jobs.start("npm run dev", "VITE ready in 300 ms\n")
    const { proc: watcher } = jobs.start("tsc --watch", "Found 0 errors. Watching for file changes.\n")
    const { terminal, live, all, shows, exited } = await setup([], {
      cols: 100,
      rows: 30,
      settings: { mode },
      extensions: [(api) => registerJobs(api, jobs.registry)],
    })
    terminal.send("/jobs\r")
    await shows("Background jobs")
    await waitFor(() => live().includes("1 job1 · running 0s · npm run dev"), "the list")
    expect(live()).toContain("2 job2 · running 0s · tsc --watch")
    expect(live()).toContain("VITE ready in 300 ms")
    expect(live()).toMatch(/x stop/)
    // x on the highlighted (first) job stops it.
    terminal.send("x")
    await shows("Stopped job1.")
    expect(jobs.procs[0]!.stops).toEqual([2000])
    await waitFor(() => jobs.registry.get("job1")!.status === "stopped", "job1 stopped")
    // Stopped on request: no notice that it ended.
    expect(all()).not.toContain("Background job job1")

    // Enter on the second job opens the view with its output, which follows as it grows.
    terminal.send("/jobs\r")
    await waitFor(() => live().includes("2 job2 · running"), "the list again")
    terminal.send("\x1b[B")
    terminal.send("\r")
    await waitFor(() => live().includes("job2 · tsc --watch"), "the view")
    expect(live()).toContain("Found 0 errors. Watching for file changes.")
    watcher.emit({ type: "output", data: "File change detected. Starting incremental compilation...\n" })
    await waitFor(() => live().includes("File change detected"), "new output in the view")
    // x in the view asks first; y stops it.
    terminal.send("x")
    await waitFor(() => live().includes("Stop job2?"), "the confirmation")
    terminal.send("y")
    await waitFor(() => live().includes("was stopped after"), "the stopped state")
    terminal.send("q")
    await waitFor(() => !live().includes("job2 · tsc --watch"), "the view to close")
    terminal.send("\x03")
    await exited
  })
}

for (const mode of ["inline", "fullscreen"] as const) {
  test(`Shift+Tab cycles the permission mode, shown in the input's border (${mode})`, async () => {
    const { agent, terminal, live, exited } = await setup([], { cols: 100, settings: { mode } })
    // Model and permission mode share a right-aligned label, including the default auto.
    await waitFor(() => /^╰─+ m1 · auto ─╯$/m.test(live()), "the status")
    expect(live()).not.toContain(" mode ")
    terminal.send("\x1b[Z")
    await waitFor(() => /^╰─+ m1 · edits ─╯$/m.test(live()), "edits in the border")
    expect(agent.permissions.mode).toBe("edits")
    expect(live()).toContain(
      "Permission mode: edits — changes files without asking; asks before shell commands",
    )
    terminal.send("\x1b[Z")
    await waitFor(() => /^╰─+ m1 · plan ─╯$/m.test(live()), "plan in the border")
    expect(agent.permissions.mode).toBe("plan")
    terminal.send("\x1b[Z")
    await waitFor(() => live().includes("Permission mode: auto"), "back to auto")
    await waitFor(() => /^╰─+ m1 · auto ─╯$/m.test(live()), "auto restored in the border")
    expect(agent.permissions.mode).toBe("auto")
    // Typed text stays: the key is not the editor's.
    terminal.send("hi")
    terminal.send("\x1b[Z")
    await waitFor(() => /^╰─+ m1 · edits ─╯$/m.test(live()), "edits again")
    expect(live()).toContain("› hi")
    terminal.send("\x03")
    terminal.send("\x03")
    await exited
  })
}

test("a job that ends on its own shows a notice; a stopped one does not", async () => {
  const jobs = fakeJobs()
  const { proc } = jobs.start("npm run dev", "")
  const { terminal, shows, exited } = await setup([], {
    cols: 100,
    extensions: [(api) => registerJobs(api, jobs.registry)],
  })
  proc.emit({ type: "output", data: "Error: port 5173 is in use\n" })
  proc.emit({ type: "exit", code: 1, signal: null })
  await shows("Background job job1 exited with code 1: npm run dev")
  terminal.send("\x03")
  await exited
})

for (const mode of ["inline", "fullscreen"] as const) {
  test(`quitting while background jobs run asks once, then quits (${mode})`, async () => {
    let running = 2
    const { terminal, live, exited } = await setup([], {
      cols: 90,
      settings: { mode },
      runningJobs: () => running,
    })
    let quit = false
    void exited.then(() => {
      quit = true
    })
    terminal.send("\x03")
    await waitFor(
      () => live().includes("2 background jobs still running — Ctrl+C again to stop them and quit"),
      "the warning",
    )
    await Bun.sleep(50)
    expect(quit).toBe(false)
    terminal.send("\x03")
    expect(await exited).toBe(0)
    // With none running, the first press quits.
    running = 0
    const second = await setup([], { cols: 90, settings: { mode }, runningJobs: () => running })
    second.terminal.send("\x04")
    expect(await second.exited).toBe(0)
  })
}
