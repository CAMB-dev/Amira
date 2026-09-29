// Manual check: bun packages/tui-kit/examples/emoji-width.ts [--all]
//
// Prints characters with an emoji form between │ bars, each padded to two cells by the width it
// is measured at, three ways: as before (Bun.stringWidth, written as it is), as now (textWidth,
// written through presentEmoji as the renderers do), and asking for text (VS15). Where the
// terminal draws a character as wide as it was measured, the bars of that column line up with
// the ones of the rows around it; where it does not, they are pushed out or drawn over.
// --all lists every character with an emoji form but no emoji presentation of its own.
import { defaultGlyphs } from "../src/glyphs.ts"
import { presentEmoji, textWidth } from "../src/width.ts"

const VS15 = "\uFE0E"
const VS16 = "\uFE0F"
const TEXT_EMOJI = /[\p{Emoji}--\p{Emoji_Presentation}]/v

const groups: [string, string[]][] = [
  [
    "Text-default emoji, now two cells and drawn as emoji",
    ["✉", "☑", "⚠", "❤", "☀", "✏", "✔", "✖", "⁉", "ℹ", "Ⓜ", "↖", "↗", "↩", "↪", "⤴", "➡", "⬆", "🖼", "⏱"],
  ],
  [
    "Kept as one-cell text (in Cascadia Mono)",
    [
      "#",
      "*",
      "1",
      "©",
      "®",
      "™",
      "‼",
      "↔",
      "↕",
      "▪",
      "▫",
      "◻",
      "◼",
      "▶",
      "◀",
      "☺",
      "♀",
      "♂",
      "♠",
      "♣",
      "♥",
      "♦",
    ],
  ],
  ["Unchanged: emoji, CJK, sequences", ["😀", "⭐", "你", "👨‍👩‍👧", "❤‍🔥", "🇯🇵", `1${VS16}\u20E3`, "☝🏽"]],
  ["Glyphs Amira draws", ["•", "◦", "▸", "▲", "✓", "✗", "●", "◆", "⊘", "›", "❯", "⌕", "⎇", "…", "─", "▎"]],
]

if (process.argv.includes("--all")) {
  const all: string[] = []
  for (let cp = 0x80; cp < 0x20000; cp++) {
    const c = String.fromCodePoint(cp)
    if (TEXT_EMOJI.test(c) && Bun.stringWidth(c) === 1) all.push(c)
  }
  groups.push(["Every character with an emoji form but no emoji presentation", all])
}

/** `text` between bars, padded to two cells by the `width` it is measured at. */
const cell = (text: string, width: number) => `│${text}${" ".repeat(Math.max(0, 2 - width))}│`
const code = (s: string) =>
  [...s]
    .filter((c) => c !== VS16 && c !== VS15)
    .map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`)
    .join(" ")

console.log("Each column should be a straight line of bars.\n")
console.log(`${"".padEnd(4)}${"code".padEnd(24)}before     now        VS15`)
for (const [title, chars] of groups) {
  console.log(`\n${title}`)
  for (const c of chars) {
    const before = cell(c, Bun.stringWidth(c))
    const now = cell(presentEmoji(c), textWidth(c))
    const text = [...c].length === 1 && /\p{Emoji}/u.test(c) ? c + VS15 : c
    const asText = cell(text, textWidth(text))
    const widths = `${Bun.stringWidth(c)}→${textWidth(c)}`
    console.log(
      `    ${code(c).slice(0, 23).padEnd(24)}${before} ${widths.padEnd(5)}${now} ${"".padEnd(5)}${asText}`,
    )
  }
}

// A row of them in a box, as a table or a border would draw them.
const row = "✉ ☑ ⚠ ❤ ☀ ✏ ✔ © ♥ ▶"
const inner = textWidth(row)
console.log(`\nIn a box (before, then now):`)
console.log(`╭${"─".repeat(Bun.stringWidth(row))}╮\n│${row}│\n╰${"─".repeat(Bun.stringWidth(row))}╯`)
console.log(`╭${"─".repeat(inner)}╮\n│${presentEmoji(row)}│\n╰${"─".repeat(inner)}╯`)
console.log(`\nMarkdown image glyph: ${cell(defaultGlyphs.image, textWidth(defaultGlyphs.image))}`)
