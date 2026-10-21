import { expect, test } from "bun:test"
import type { ViewDefinition } from "@amira/api"
import { defaultTheme, stripAnsi } from "@amira/tui-kit"
import { type BlockEnv, SummaryBlock } from "../src/blocks.ts"
import { ExtensionViewer } from "../src/extension-view.ts"
import { setup, waitFor } from "./app-harness.ts"

const file = "file:///C:/Windows/win.ini"
const editor = "vscode://file/C:/Windows/win.ini"
const web = "https://example.invalid/remote-source"
const text = `[remote file](${file}) [remote editor](${editor}) [remote web](${web})`
const osc = (target: string) => `\x1b]8;;${target}\x07`
const policies = ["web", true, false] as const

for (const placement of ["fullscreen", "dock"] as const)
  test(`local ${placement} overlay forwards the host's enabled link policy`, async () => {
    const previous = process.env.FORCE_HYPERLINK
    // A fallback to process.env would lose links; the UI's explicit env must win.
    process.env.FORCE_HYPERLINK = "0"
    let app: Awaited<ReturnType<typeof setup>> | undefined
    try {
      app = await setup([], {
        cols: 120,
        rows: 35,
        env: { FORCE_HYPERLINK: "1" },
        extensions: [
          (api) => {
            api.registerView({
              kind: "links",
              title: () => "Links",
              render: (_data, options) => options.renderReply!(text),
            })
            api.registerCommand({
              name: "links",
              description: "Open links",
              run: (_args, ctx) => {
                ctx.openView?.({ kind: "links", placement })
              },
            })
          },
        ],
      })
      app.terminal.clearWrites()
      app.terminal.send("/links\r")
      await waitFor(() => stripAnsi(app!.terminal.output).includes("remote web"), "link overlay")
      checkLinks(app.terminal.output, true)
    } finally {
      app?.terminal.send("\x03\x03\x03")
      await app?.exited
      if (previous === undefined) delete process.env.FORCE_HYPERLINK
      else process.env.FORCE_HYPERLINK = previous
    }
  })

function checkLinks(output: string, policy: (typeof policies)[number]) {
  expect(output.includes(osc(file))).toBe(policy === true)
  expect(output.includes(osc(editor))).toBe(policy === true)
  expect(output.includes(osc(web))).toBe(policy !== false)
  expect(stripAnsi(output)).toContain("remote file")
  expect(stripAnsi(output)).toContain("remote editor")
  expect(stripAnsi(output)).toContain("remote web")
}

async function withHyperlinks(run: () => void) {
  const previous = process.env.FORCE_HYPERLINK
  process.env.FORCE_HYPERLINK = "1"
  try {
    run()
  } finally {
    if (previous === undefined) delete process.env.FORCE_HYPERLINK
    else process.env.FORCE_HYPERLINK = previous
  }
}

for (const hyperlinks of policies) {
  test(`expanded summaries preserve ${hyperlinks} hyperlink policy`, async () => {
    await withHyperlinks(() => {
      const env: BlockEnv = {
        theme: defaultTheme,
        width: 120,
        now: 0,
        spinner: "*",
        detail: "summary",
        presenters: undefined,
        hyperlinks,
        nodes: new Map(),
      }
      const block = new SummaryBlock(text)
      expect(block.lines(env).join("\n")).not.toContain("\x1b]8;;")
      block.toggleFold()
      checkLinks(block.lines(env).join("\n"), hyperlinks)
      checkLinks(block.printLines(env).join("\n"), hyperlinks)
    })
  })

  for (const placement of ["fullscreen", "dock"] as const)
    test(`${placement} reply rendering preserves ${hyperlinks} hyperlink policy across pages`, async () => {
      await withHyperlinks(() => {
        const definition: ViewDefinition = {
          kind: "links",
          title: () => "Links",
          render: (_data, options) => options.renderReply!(text),
          onOpen: (_data, control) => control.pushPage({ title: "Nested links" }),
        }
        const viewer = new ExtensionViewer(definition, {}, { placement, hyperlinks })
        viewer.mount()
        try {
          checkLinks(
            viewer.render(120, { theme: defaultTheme, color: true, rows: 20 }).join("\n"),
            hyperlinks,
          )
        } finally {
          viewer.dispose()
        }
      })
    })
}
