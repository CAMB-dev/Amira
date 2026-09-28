export interface Frontmatter {
  data: Record<string, unknown>
  body: string
}

/** Splits `---` YAML frontmatter from a Markdown document. Throws on invalid YAML. */
export function parseFrontmatter(text: string): Frontmatter {
  const src = text.replace(/^﻿/, "")
  const match = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(src)
  if (!match) return { data: {}, body: src }
  const yaml = match[1] ?? ""
  const parsed = yaml.trim() ? Bun.YAML.parse(yaml) : {}
  const data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  return { data: data as Record<string, unknown>, body: src.slice(match[0].length) }
}
