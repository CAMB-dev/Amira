import { expect, test } from "bun:test"
import { closeImageApp, inputImage, setup, waitFor } from "./app-harness.ts"

for (const mode of ["inline", "fullscreen"] as const) {
  for (const [key, name] of [
    ["\x1b[27u", "Esc"],
    ["\x03", "Ctrl+C"],
  ]) {
    test(`${mode}: ${name} keeps the last known context fill after interrupting`, async () => {
      const s = await setup(
        [
          { text: "First answer", usage: { input: 12_000, output: 800 } },
          { text: "A long streaming reply ".repeat(20), delayMs: 20 },
        ],
        { cols: 100, settings: { mode } },
      )
      try {
        s.terminal.send("first\r")
        await s.shows("First answer")
        await s.idle()
        await waitFor(() => /^ \/work\/proj +13k \/ 128k$/m.test(s.live()), "known context fill")
        s.terminal.send("second\r")
        await s.shows("A long")
        s.terminal.send(key!)
        await s.shows("Interrupted")
        await s.idle()
        expect(s.agent.messages.at(-1)).toMatchObject({
          role: "assistant",
          stopReason: "aborted",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })
        expect(s.live()).toMatch(/^ \/work\/proj +13k \/ 128k$/m)
      } finally {
        await closeImageApp(s)
      }
    })
  }

  test(`${mode}: a claimed member address never shows matching files`, async () => {
    const frames: string[] = []
    const s = await setup([], {
      settings: { mode },
      commands: [],
      inputs: [{ name: "swarm", claims: (text) => /^@writer(?:\s|$)/.test(text), run: () => {} }],
      files: ["writer.ts", "other.ts"],
      acceptsImages: true,
      clipboard: async () => ({ type: "image", image: inputImage() }),
      onWrite: (screen) => frames.push(screen.text),
    })
    try {
      s.terminal.send("@writer")
      await waitFor(() => s.live().includes("│ › @writer"), "member address in editor")
      await Bun.sleep(50)
      expect(frames.some((frame) => frame.includes("❯ writer.ts"))).toBe(false)
      expect(s.live()).not.toContain("❯ writer.ts")
      // A file mention elsewhere in a message is not an addressed line.
      s.terminal.send("\x03see @writer")
      await waitFor(() => s.live().includes("❯ writer.ts"), "ordinary file mention")
      // Attachments make this a model message, even when its text matches a handler.
      s.terminal.send("\x03\x1bv")
      await s.shows("[image 1: photo.png 68 B]")
      s.terminal.send(" @writer")
      await waitFor(() => s.live().includes("❯ writer.ts"), "file mention with an attachment")
    } finally {
      await closeImageApp(s)
    }
  })
}
