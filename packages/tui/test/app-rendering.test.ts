// A/B/D deliberate UI oracles: shared two-cell grid, fill-only code, rounded dialogs, › and ·.
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  ExtensionAdmin,
  ExtensionProgress,
  ImageInput,
  ImageOpenContext,
  ImageProvider,
  SessionControl,
} from "@amira/api"
import type { GraphicsReplies } from "@amira/tui-kit"
import { extensionCommand } from "../../../extensions/commands/src/index.ts"
import { SPAWN_TEST_TIMEOUT_MS, waitForSpawnCondition } from "../../../scripts/spawn-test.ts"
import { fakePayload } from "../../tui-kit/test/fake-images.ts"
import { FileIndex, streamProjectFiles } from "../src/file-index.ts"
import { defaultKeys, Keybindings } from "../src/keybindings.ts"
import { exchange, type SetupOptions, setup, testCommands, waitFor } from "./app-harness.ts"
import { boundSpawnSync, waitForSpawnWork } from "./spawn-fixture.ts"

function testImages(
  size: (input: ImageInput, ctx: ImageOpenContext) => Promise<{ width: number; height: number } | undefined>,
): ImageProvider {
  return {
    id: "test-images",
    open: async (input, ctx) => {
      const s = await size(input, ctx)
      return s && { ...s, encode: async (req) => fakePayload(req) }
    },
  }
}
/** 30×40 pixels: 3 columns and 2 rows of 10×20 cells, as Sixel draws it in whole bands. */
const CHART = { width: 30, height: 40 }
const SIXEL: GraphicsReplies = { answered: true, sixel: true, kitty: false }
const WT = { WT_SESSION: "1" }

test("without an image provider, one that cannot open it, or tui.images off, an image is its alt text", async () => {
  const setups: ({ images?: boolean; background?: boolean } | undefined)[] = []
  const run = async (text: string, o: Partial<SetupOptions>) => {
    const { terminal, screen, all, shows, idle, exited } = await setup([{ text }], {
      env: WT,
      graphics: SIXEL,
      onSetup: (opts) => setups.push(opts),
      ...o,
    })
    terminal.send("go\r")
    await shows("done")
    await idle()
    const out = { text: all(), images: screen.images.length }
    terminal.send("\x03")
    await exited
    return out
  }
  // No images extension: the terminal could draw it, but nothing makes it drawable (D88).
  const local = await run("![secret](https://img.test/secret.png)\n\ndone", {})
  expect(local.images).toBe(0)
  // Windows Terminal makes links clickable: the URL is in the link, not shown.
  expect(local.text).toMatch(/^ {2}🖼\uFE0F secret +(?:[01]\d|2[0-3]):[0-5]\d\n\n {2}done$/m)
  const failing = await run("![gone](https://img.test/404.png)\n\ndone", {
    images: testImages(async () => {
      throw new Error("HTTP 404")
    }),
  })
  expect(failing.images).toBe(0)
  expect(failing.text).toMatch(/^ {2}🖼\uFE0F gone +\d{2}:\d{2}\n\n {2}done$/m)
  const off = await run("![chart](https://img.test/chart.png)\n\ndone", {
    settings: { images: "off" },
    images: testImages(async () => CHART),
  })
  expect(off.images).toBe(0)
  expect(off.text).toContain("  🖼\uFE0F chart")
  expect(setups).toEqual([
    { images: true, background: true },
    { images: true, background: true },
    { images: false, background: true },
  ])
  // Without Sixel in the terminal's answer, "auto" draws none either.
  const text = await run("![chart](https://img.test/chart.png)\n\ndone", {
    graphics: { answered: true, sixel: false, kitty: false },
    images: testImages(async () => CHART),
  })
  expect(text.images).toBe(0)
})

test("extension installs stay responsive and cancel through actual Esc/Ctrl+C at 120/60 columns in fullscreen", async () => {
  for (const mode of ["fullscreen"] as const)
    for (const cols of [120, 60])
      for (const stop of ["\x1b", "\x03"]) {
        let progress!: (p: ExtensionProgress) => void
        let active: AbortSignal | undefined
        let finished = false
        let reloads = 0
        const admin: ExtensionAdmin = {
          list: () => [],
          search: async () => ({ extensions: [], warnings: [] }),
          install: async (_name, _scope, opts) => {
            active = opts.signal
            progress = opts.onProgress
            opts.onProgress({
              name: "fixture",
              phase: "fetching",
              percent: 42,
              detail: "local fixture repository",
            })
            return new Promise((_resolve, reject) =>
              opts.signal.addEventListener(
                "abort",
                () => {
                  finished = true
                  reject(opts.signal.reason)
                },
                { once: true },
              ),
            )
          },
          update: async () => {},
          remove: () => {},
          setEnabled: () => true,
        }
        const control: Partial<SessionControl> = {
          extensionAdmin: admin,
          info: () => ({
            id: agent.sessionId,
            cwd: agent.cwd,
            busy: false,
            model: { provider: "mock", model: "m1" },
            contextWindow: 128000,
            shell: "auto",
          }),
          reloadExtensions: async () => {
            reloads++
            return undefined
          },
        }
        const { terminal, live, all, agent, host, exited } = await setup([], {
          cols,
          rows: 24,
          commands: [],
          settings: { mode },
          control,
        })
        await host.load((api) => {
          api.registerCommand(extensionCommand(api).command)
        }, "test-ext")
        terminal.send("/ext install fixture\r")
        await waitFor(
          () => active !== undefined && live().includes("fetching 42%"),
          `${mode}/${cols}: fetching`,
        )
        expect(live().split("\n")).toContain(
          cols === 120
            ? "  shift+tab mode  ·  esc cancel command  ·  ctrl+o detail  ·  ? keys  ·  enter send"
            : "  shift+tab mode  ·  esc cancel command  ·  ctrl+o detail",
        )
        // One key in the hint, as while a turn runs; Ctrl+C cancels too.
        expect(live()).not.toContain("ctrl+c cancel command")
        terminal.send("draft stays available")
        await waitFor(() => live().includes("draft stays available"), `${mode}/${cols}: responsive draft`)
        progress({ name: "fixture", phase: "extracting", detail: "local fixture repository" })
        await waitFor(() => live().includes("extracting"), `${mode}/${cols}: extracting`)
        terminal.send(stop)
        await waitFor(
          () => finished && all().includes("Extension operation cancelled"),
          `${mode}/${cols}: cancelled`,
        )
        expect(active?.aborted).toBe(true)
        expect(live()).toContain("draft stays available")
        await waitFor(() => !live().includes("Extensions · working"), `${mode}/${cols}: panel removed`)
        expect(agent.messages).toHaveLength(0)
        expect(reloads).toBe(0)
        terminal.send("\x03")
        terminal.send("\x04")
        await exited
      }
})

test("extension picker sections filter and show details at 120/60 columns in fullscreen", async () => {
  for (const mode of ["fullscreen"] as const)
    for (const cols of [120, 60]) {
      const admin: ExtensionAdmin = {
        list: () => [
          {
            name: "fixture",
            version: "1.0.0",
            scope: "user",
            enabled: true,
            trusted: true,
            source: "local repository",
            description: "Installed fixture",
          },
        ],
        search: async () => ({
          extensions: [{ name: "available", version: "2.0.0", description: "New extension" }],
          warnings: [],
        }),
        install: async () => {
          throw new Error("Unexpected install")
        },
        update: async () => {},
        remove: () => {},
        setEnabled: () => true,
      }
      const control: Partial<SessionControl> = {
        extensionAdmin: admin,
        info: () => ({
          id: agent.sessionId,
          cwd: agent.cwd,
          busy: false,
          model: { provider: "mock", model: "m1" },
          contextWindow: 128000,
          shell: "auto",
        }),
      }
      const { terminal, live, all, agent, host, exited } = await setup([], {
        cols,
        rows: 30,
        commands: [],
        settings: { mode },
        control,
      })
      await host.load((api) => {
        api.registerCommand(extensionCommand(api).command)
      }, "test-ext-picker")
      terminal.send("/ext\r")
      await waitFor(() => live().includes("Available from the index"), `${mode}/${cols}: available section`)
      expect(live()).toContain("Installed")
      expect(live()).toContain("d details")
      // The progress panel is for installs and updates, not for the picker.
      expect(live()).not.toContain("Extensions · working")
      terminal.send("avail")
      await waitFor(
        () => live().includes("filter") && !live().includes("fixture 1.0.0"),
        `${mode}/${cols}: filter`,
      )
      terminal.send("\x1b")
      await waitFor(() => host.ui.pending.length === 0, `${mode}/${cols}: dismissed`)
      terminal.send("/ext\r")
      await waitFor(() => live().includes("Available from the index"), `${mode}/${cols}: reopened`)
      terminal.send("d")
      await waitFor(() => all().includes("Source: local repository"), `${mode}/${cols}: details`)
      expect(agent.messages).toHaveLength(0)
      terminal.send("\x04")
      await exited
    }
})

test("cancelling an extension operation leaves concurrent compaction alone; compact aliases stop only their compaction", async () => {
  for (const viaCommand of [false, true]) {
    let extensionCancelled = false
    let compacted: Promise<boolean> | undefined
    const { terminal, live, all, agent, host, exited } = await setup(
      [{ text: "SUMMARY ".repeat(100), delayMs: 20 }],
      {
        cols: 120,
        history: [...exchange("a"), ...exchange("b")],
        aliases: { summarize: "compact" },
        commands: [
          {
            name: "compact",
            description: "Compact",
            run: async () => {
              compacted = agent.compact()
              await compacted
            },
          },
          {
            name: "ext",
            description: "Extension operation",
            run: async (_args, ctx) =>
              new Promise<void>((resolve) =>
                ctx.signal.addEventListener(
                  "abort",
                  () => {
                    extensionCancelled = true
                    ctx.print("Extension cancelled")
                    resolve()
                  },
                  { once: true },
                ),
              ),
          },
        ],
      },
    )
    expect(host.commands.has("compact")).toBe(true)
    if (viaCommand) terminal.send("/summarize\r")
    else compacted = agent.compact()
    await waitFor(() => live().includes("Compacting the conversation…"), "concurrent compaction")
    let aborts = 0
    const abort = agent.abort.bind(agent)
    agent.abort = (...args) => {
      aborts++
      return abort(...args)
    }
    terminal.send("/ext install fixture\r")
    await waitFor(() => all().includes("/ext install fixture"), "extension started")
    terminal.send("\x1b")
    await waitFor(() => extensionCancelled, "extension cancelled")
    expect(aborts).toBe(0)
    expect(agent.busy).toBe(true)
    if (viaCommand) {
      terminal.send("\x1b")
      await waitFor(() => aborts === 1, "compact alias cancelled")
      expect(await compacted).toBe(false)
    } else expect(await compacted).toBe(true)
    await waitFor(() => !agent.busy, "compaction finished")
    terminal.send("\x04")
    await exited
  }
})

test("live panels sit above the input in fullscreen, fold with Ctrl+T and follow their state", async () => {
  for (const mode of ["fullscreen"] as const) {
    let items = ["✓ write the parser", "› test it", "• ship it"]
    let seen: { sessionId: string; hasData: boolean } | undefined
    const { terminal, live, host, exited } = await setup([], {
      cols: 100,
      settings: { mode },
      panels: [
        {
          id: "todo",
          render: (o) => {
            seen = { sessionId: o.sessionId, hasData: !!o.data }
            if (!items.length) return []
            return [
              {
                kind: "muted",
                text: `Todos ${items.filter((i) => i.startsWith("✓")).length}/${items.length}`,
              },
              ...items.map((text) => ({ kind: text.startsWith("›") ? "accent" : "text", text }) as const),
            ]
          },
        },
      ],
    })
    await waitFor(() => live().includes("› test it"), `${mode}: the panel`)
    const rows = live().split("\n")
    // On the content column, as the input box text and the key hint.
    const panelRow = rows.findIndex((r) => r.startsWith("  Todos 1/3"))
    const boxRow = rows.findIndex((r) => r.startsWith("╭"))
    expect(panelRow).toBeGreaterThan(-1)
    // The panel, then a blank line, then the input box.
    expect(boxRow).toBe(panelRow + 5)
    expect(seen?.hasData).toBe(true)
    // How to fold them is in the key reference, not the hint.
    expect(live()).not.toContain("fold panels")
    terminal.send("\x14")
    await waitFor(() => !live().includes("› test it"), `${mode}: folded`)
    expect(live()).toContain("Todos 1/3")
    // Folded, the hint says how to unfold them.
    expect(live()).toMatch(
      /^ {2}shift\+tab mode {2}· {2}ctrl\+o detail {2}· {2}\? keys {2}· {2}ctrl\+t unfold panels$/m,
    )
    terminal.send("\x14")
    items = ["✓ write the parser", "✓ test it", "› ship it"]
    // A change shows at the next redraw the extension asks for.
    await host.load((api) => api.requestRender(), `render-${mode}`)
    await waitFor(() => live().includes("› ship it"), `${mode}: updated`)
    items = []
    await host.load((api) => api.requestRender(), `render2-${mode}`)
    await waitFor(() => !live().includes("Todos"), `${mode}: hidden when empty`)
    terminal.send("\x04")
    await exited
  }
})

test("live panels give way on a short screen: folded, then cut, the input box always shown", async () => {
  for (const mode of ["fullscreen"] as const) {
    const items = Array.from({ length: 9 }, (_, i) => `• step ${i + 1}`)
    const { terminal, live, exited } = await setup([], {
      cols: 70,
      rows: 12,
      settings: { mode },
      panels: [
        {
          id: "todo",
          render: () => [
            { kind: "muted", text: "Todos 0/9" },
            ...items.map((text) => ({ kind: "text" as const, text })),
          ],
        },
      ],
    })
    await waitFor(() => live().includes("Todos 0/9"), `${mode}: the panel`)
    const rows = live().split("\n")
    // Folded to its header, since the whole list does not fit; the input box and hints stay.
    expect(live()).not.toContain("step 1")
    const panel = rows.indexOf("  Todos 0/9")
    const top = rows.findIndex((r) => r.startsWith("╭"))
    expect(rows.slice(panel, top)).toEqual(mode === "fullscreen" ? ["  Todos 0/9"] : ["  Todos 0/9", ""])
    expect(rows.some((r) => r.startsWith("╰"))).toBe(true)
    expect(rows).toContain("  shift+tab mode  ·  ctrl+o detail  ·  ? keys")
    terminal.send("\x04")
    await exited
  }
})

test("an extension's notice shows in the transcript", async () => {
  const { host, shows, terminal, exited } = await setup([])
  await host.load((api) => api.notify("hook prettier · a.ts · ok", "success"), "ext:hooks")
  await shows("✓ hook prettier · a.ts · ok")
  terminal.send("\x03")
  await exited
})

test("the status stays below the intact frame when a dialog takes the input box's place and closes", async () => {
  for (const mode of ["fullscreen"] as const) {
    const { terminal, live, host, bus, agent, exited } = await setup([], { settings: { mode } })
    bus.emit(
      "workspace.changed",
      { cwd: "/work/proj", repoRoot: "/work/proj", branch: "main", dirty: true },
      {
        sessionId: agent.sessionId,
      },
    )
    await waitFor(
      () =>
        /^ {2}⎇ main\* {2}\/work\/proj +0 \/ 128K$/m.test(live()) &&
        /^╰─{58}╯\n {51}m1 · auto$/m.test(live()),
      `${mode}: header and input status`,
    )
    expect(live()).toMatch(/^ {2}⎇ main\* {2}\/work\/proj +0 \/ 128K$/m)
    const answer = host.ui.api("x").confirm("Proceed?")
    await waitFor(() => live().includes("Proceed?"), `${mode}: the dialog`)
    const rows = live().split("\n")
    // No input box: the status stays under the intact dialog frame, and the composer hint is gone.
    expect(rows).toContain(`╰${"─".repeat(58)}╯`)
    const status = rows.findIndex((r) => /^ {51}m1 · auto$/.test(r))
    expect(status).toBe(rows.findIndex((r) => r.startsWith("╰")) + 1)
    expect(status).toBeGreaterThan(rows.findIndex((r) => r.includes("Proceed?")))
    expect(live()).not.toContain("shift+tab mode")
    expect(live()).toMatch(/^ {2}⎇ main\* {2}\/work\/proj +0 \/ 128K$/m)
    terminal.send("\x1b[27u")
    expect(await answer).toBeUndefined()
    await waitFor(
      () => live().includes("│ › Message Amira") && /^╰─{58}╯\n {51}m1 · auto$/m.test(live()),
      `${mode}: composer and status restored`,
    )
    expect(live()).toMatch(/^ {51}m1 · auto$/m)
    terminal.send("\x03")
    await exited
  }
})

test("a command list below the input box leaves the separate status below its plain bottom edge", async () => {
  const { terminal, live, exited } = await setup([], { commands: testCommands([]) })
  terminal.send("/")
  await waitFor(() => live().includes("tab complete · enter run · esc close"), "the list")
  expect(live()).toMatch(/^╰─{58}╯\n {51}m1 · auto$/m)
  terminal.send("\x03\x03")
  await exited
})

test("the right-aligned model stays below the plain border; workspace, cost and context fit the header in fullscreen", async () => {
  for (const mode of ["fullscreen"] as const) {
    for (const cols of [100, 44, 34, 12]) {
      const { terminal, live, agent, bus, idle, exited } = await setup(
        [{ text: "ok", usage: { input: 108_800, output: 0, cost: 0.042 } }],
        { cols, settings: { mode } },
      )
      bus.emit(
        "workspace.changed",
        { cwd: "/work/proj", repoRoot: "/work/proj", branch: "feat/x", dirty: true },
        {
          sessionId: agent.sessionId,
        },
      )
      terminal.send("go\r")
      await idle()
      const status = () => {
        const rows = live().split("\n")
        return rows[rows.findIndex((r) => r.startsWith("╰")) + 1] ?? ""
      }
      await waitFor(() => status().includes("m1"), `${mode} ${cols}: the status`)
      const line = status()
      expect([mode, cols, line.length]).toEqual([mode, cols, cols])
      expect(line.endsWith("m1 · auto")).toBe(true)
      for (const row of live().split("\n")) expect(row.length).toBeLessThanOrEqual(cols)
      expect(line).toBe(`${" ".repeat(cols - 9)}m1 · auto`)
      expect(
        live()
          .split("\n")
          .find((r) => r.startsWith("╰")),
      ).toBe(`╰${"─".repeat(cols - 2)}╯`)
      const header = {
        100: `  ⎇ feat/x*  /work/proj${" ".repeat(55)}$0.042  ·  109K / 128K`,
        44: "  ⎇ feat/x*  …/proj   $0.042  ·  109K / 128K",
        34: "  ⎇ feat/x… $0.042  ·  109K / 128K",
        12: " 109K / 128K",
      }[cols]!
      const rows = live().split("\n")
      const headerRow = mode === "fullscreen" ? 0 : rows.findIndex((r) => r.startsWith("╭")) - 1
      expect(rows[headerRow]).toBe(header)
      // Fullscreen reserves the header and its separator; inline keeps it against the composer.
      if (mode === "fullscreen") expect(rows[1]).toBe("")
      for (const item of ["109K", "$0.042", "feat/x*", "/work/proj"]) expect(line).not.toContain(item)
      terminal.send("\x03")
      await exited
    }
  }
})

test("? opens the key reference on an empty input; it lists every action with its keys and Esc closes it", async () => {
  for (const mode of ["fullscreen"] as const) {
    const keys = new Keybindings({ ...defaultKeys({ vscode: false }), queue: ["ctrl+t"] })
    const { terminal, live, exited } = await setup([], { settings: { mode }, keybindings: keys, rows: 20 })
    await waitFor(
      () => /^ {2}shift\+tab mode {2}· {2}ctrl\+o detail {2}· {2}\? keys$/m.test(live()),
      `${mode}: the hint`,
    )
    terminal.send("?")
    await waitFor(() => live().includes("Keys"), `${mode}: the reference`)
    const text = live()
    expect(text).toContain("To change a key, map the action name")
    expect(text).toMatch(/^ {2}Input$/m)
    // The keys bound now, all of them, next to what they do.
    expect(text).toMatch(/^ {2}enter +Send the message/m)
    expect(text).toMatch(/^ {2}ctrl\+t +While a turn runs, send the message/m)
    // Keys that do not fit the column go on under it; the action's name follows its description.
    expect(text).toMatch(/^ {2}shift\+enter, +Insert a line break · newline\n {2}ctrl\+enter$/m)
    expect(text).toMatch(/↑↓ pgup pgdn home end scroll · esc close$/m)
    // It scrolls to the end, where the last group is.
    terminal.send("\x1b[F")
    await waitFor(() => /^ {2}end · /m.test(live()), `${mode}: scrolled to the end`)
    // The transcript's keys are listed only where the full-screen view has them.
    expect(live().includes("Text selected with the mouse")).toBe(mode === "fullscreen")
    terminal.send("\x1b[27u")
    await waitFor(
      () => /^ {2}shift\+tab mode {2}· {2}ctrl\+o detail {2}· {2}\? keys$/m.test(live()),
      `${mode}: closed`,
    )
    expect(live()).not.toContain("Keys")
    // With text in the input, ? is typed.
    terminal.send("a?")
    await waitFor(() => live().includes("│ › a?"), `${mode}: typed`)
    expect(live()).not.toContain("Keys")
    terminal.send("\x03\x03")
    await exited
  }
})

test("the input's editing keys: Ctrl+W and Ctrl+U cut, Ctrl+Y pastes back, Ctrl+Z undoes", async () => {
  const { terminal, live, exited } = await setup([])
  terminal.send("one two three")
  await waitFor(() => live().includes("one two three"), "typed")
  terminal.send("\x17")
  await waitFor(() => live().includes("│ › one two ") && !live().includes("three"), "word cut")
  terminal.send("\x15")
  await waitFor(() => !live().includes("one two"), "line cut")
  terminal.send("\x19")
  await waitFor(() => live().includes("one two"), "pasted back")
  terminal.send("\x1a")
  await waitFor(() => !live().includes("one two"), "undone")
  terminal.send("\x03")
  terminal.send("\x03")
  await exited
})

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: regression: a yank ends the kill sequence before the next Ctrl+W`, async () => {
    const { terminal, live, exited } = await setup([], { settings: { mode } })
    const input = () =>
      live()
        .split("\n")
        .find((line) => line.startsWith("│ › "))
        ?.slice(2)
        .replace(/ *│$/, "")
    try {
      terminal.send("one two")
      await waitFor(() => input() === "› one two", "typed input")
      terminal.send("\x17") // Ctrl+W
      await waitFor(() => input() === "› one", "first word cut")
      terminal.send("\x19") // Ctrl+Y
      await waitFor(() => input() !== "› one", "first yank rendered")
      expect(input()).toBe("› one two")
      terminal.send("\x17") // Ctrl+W
      await waitFor(() => input() === "› one", "second word cut")
      terminal.send("\x19") // Ctrl+Y
      await waitFor(() => input() !== "› one", "second yank rendered")
      expect(input()).toBe("› one two")
    } finally {
      terminal.send("\x03\x03")
      await exited
    }
  })

  test(
    `${mode}: regression: one Ctrl+Z restores the input before Tab file completion`,
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "amira-completion-undo-"))
      let listing: Promise<boolean> | undefined
      const fileSource = new FileIndex(dir, {
        list: (cwd, emit, signal) => (listing = streamProjectFiles(cwd, emit, { signal })),
      })
      try {
        writeFileSync(join(dir, "readme.md"), "Completion fixture\n")
        const { terminal, live, exited } = await setup([], { settings: { mode }, fileSource })
        const input = () =>
          live()
            .split("\n")
            .find((line) => line.startsWith("│ › "))
            ?.slice(2)
            .replace(/ *│$/, "")
        try {
          terminal.send("review @rea")
          await waitForSpawnCondition("fixture selected in the @ file list", () =>
            live().includes("› readme.md"),
          )
          expect(input()).toBe("› review @rea")
          expect(live()).toContain("tab/enter insert")
          terminal.send("\t")
          await waitFor(() => input() === "› review @readme.md", "file completion inserted")
          expect(live()).not.toContain("tab/enter insert")
          terminal.send("\x1a") // Ctrl+Z: undo the entire completion in one step.
          await waitFor(() => input() !== "› review @readme.md", "undo rendered")
          expect(input()).toBe("› review @rea")
        } finally {
          terminal.send("\x03\x03")
          await waitForSpawnWork(exited, "file completion app cleanup")
        }
      } finally {
        fileSource.dispose()
        try {
          if (listing) await waitForSpawnWork(listing, "file completion listing cleanup")
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  )
}

test(
  "Ctrl+G edits the message in $VISUAL and takes the text back",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "amira-editor-"))
    const script = join(dir, "fake-editor.ts")
    const boundedSpawn = boundSpawnSync()
    try {
      writeFileSync(
        script,
        'import { appendFileSync } from "node:fs"\nappendFileSync(process.argv[2]!, " and more\\n")\n',
      )
      const { terminal, live, exited } = await setup([], {
        cwd: dir,
        env: { VISUAL: `"${process.execPath}" "${script}"` },
      })
      try {
        terminal.send("draft")
        await waitFor(() => live().includes("│ › draft"), "typed")
        terminal.send("\x07")
        await waitForSpawnCondition("external editor result", () => live().includes("│ › draft and more"))
      } finally {
        terminal.send("\x03\x03")
        await waitForSpawnWork(exited, "external editor app cleanup")
      }
    } finally {
      boundedSpawn.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  },
  SPAWN_TEST_TIMEOUT_MS,
)

test("full screen, the input box stays put while the list under it gets shorter", async () => {
  const { terminal, live, screen, exited } = await setup([], {
    commands: testCommands([]),
    settings: { mode: "fullscreen" },
  })
  const boxTop = () => screen.lines.findIndex((l) => l.startsWith("╭"))
  terminal.send("/")
  await waitFor(() => live().includes("/status"), "the list")
  const top = boxTop()
  terminal.send("mo")
  await waitFor(() => live().includes("› /model") && !live().includes("/status"), "narrowed")
  expect(boxTop()).toBe(top)
  // Closed, the rows it kept go too.
  terminal.send("\x1b[27u")
  await waitFor(() => !live().includes("Switch the model"), "closed")
  expect(boxTop()).toBeGreaterThan(top)
  terminal.send("\x03")
  terminal.send("\x03")
  await exited
})

test("commands get the common keys as bound now, for /help; the transcript's only full screen", async () => {
  for (const mode of ["fullscreen"] as const) {
    const { terminal, shows, all, exited } = await setup([], {
      cols: 120,
      rows: 32,
      settings: { mode },
      commands: [
        {
          name: "keys",
          description: "List the keys",
          run: (_a, ctx) =>
            ctx.print((ctx.keys?.() ?? []).map((k) => `${k.keys}=${k.description}`).join("\n")),
        },
      ],
    })
    terminal.send("/keys\r")
    await shows("enter=Send the message; while a turn runs, steer it")
    expect(all()).toContain("ctrl+r=Search the prompts sent before")
    expect(all()).toContain(
      "esc=Cancel a command or stop the turn; twice in a row, rewind to an earlier message",
    )
    expect(all()).toContain("?=Every key and what it does")
    expect(all()).toContain("esc=Focus a selectable dock when the input is empty; otherwise close it")
    if (mode === "fullscreen") expect(all()).toContain("ctrl+f=Find text in the transcript")
    else expect(all()).not.toContain("Find text in the transcript")
    terminal.send("\x03")
    await exited
  }
})

for (const mode of ["fullscreen"] as const) {
  test(`${mode}: a hosted web search shows as a row, then the reply and the sources it cited`, async () => {
    const { ai, terminal, all, shows, idle, exited } = await setup([], {
      settings: { mode },
      cols: 80,
      rows: 30,
    })
    const search = {
      type: "serverTool" as const,
      id: "ws_1",
      name: "web_search",
      input: { type: "search", query: "node lts" },
      status: "done" as const,
    }
    const url = "https://nodejs.org/en/download"
    let release!: () => void
    const searched = new Promise<void>((r) => {
      release = r
    })
    // The mock provider searching on its side: the row shows while the search runs.
    ai.registerDialect({
      id: "mock",
      async *stream(req) {
        yield { type: "start" }
        yield { type: "text.delta", text: "Let me check." }
        yield { type: "serverTool", block: { ...search, status: "running" } }
        await searched
        yield { type: "serverTool", block: search }
        yield { type: "text.delta", text: "v24 is the LTS." }
        yield {
          type: "done",
          message: {
            role: "assistant",
            model: { provider: req.model.provider, model: req.model.id },
            content: [
              { type: "text", text: "Let me check." },
              search,
              { type: "text", text: "v24 is the LTS.", citations: [{ url, title: "Download Node.js" }] },
            ],
            stopReason: "end",
          },
        }
      },
    })
    terminal.send("which node?\r")
    await shows("web_search node lts")
    release()
    await shows("1. Download Node.js")
    await idle()
    const text = all()
    expect(text.indexOf("Let me check.")).toBeLessThan(text.indexOf("web_search"))
    expect(text.indexOf("web_search")).toBeLessThan(text.indexOf("v24 is the LTS."))
    expect(text.indexOf("v24 is the LTS.")).toBeLessThan(text.indexOf("Sources:"))
    expect(text).toMatch(/^└ web_search node lts {2}✓ Web search: "node lts"$/m)
    // The row is shown once, not once per state.
    expect(text.split("└ web_search").length).toBe(2)
    terminal.send("\x03")
    await exited
  })
}
