import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const guides = [
  {
    path: "../docs/usage.md",
    claude: /Claude API.*separate.*rate limits/,
    openai: /OpenAI.*shares.*standard model.*rate limits/,
    gemini: /Google Gemini.*overflow.*downgrade to standard/,
    blanket: "Separate pricing and capacity limits apply.",
  },
  {
    path: "../docs/zh/usage.md",
    claude: /Claude 官方 API.*单独的速率限制/,
    openai: /OpenAI.*共享.*标准.*速率限制/,
    gemini: /Google Gemini.*容量超限.*降级为标准/,
    blanket: "快速模式采用单独的定价和容量限制。",
  },
  {
    path: "../docs/ja/usage.md",
    claude: /Claude 公式 API.*別のレート制限/,
    openai: /OpenAI.*標準.*レート制限を共有/,
    gemini: /Google Gemini.*容量超過.*標準層にダウングレード/,
    blanket: "料金と容量制限は標準モードとは別です。",
  },
]

for (const guide of guides) {
  test(`${guide.path}: fast-mode limits distinguish Claude, OpenAI and Gemini`, () => {
    const text = readFileSync(new URL(guide.path, import.meta.url), "utf8")
    expect(text).toMatch(guide.claude)
    expect(text).toMatch(guide.openai)
    expect(text).toMatch(guide.gemini)
    expect(text).not.toContain(guide.blanket)
  })
}
