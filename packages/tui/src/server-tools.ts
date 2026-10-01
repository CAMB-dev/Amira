import { type AssistantContent, type Citation, messageCitations } from "@amira/ai"

export { serverToolView as serverToolCall } from "@amira/api"

/** Link text in Markdown: brackets and backslashes escaped, on one line. */
function linkText(s: string): string {
  return s.replace(/\s+/g, " ").replace(/[\\[\]]/g, (c) => `\\${c}`)
}

/** Markdown after a reply that cites sources: each one, once, as a link under its title. */
export function citationsMarkdown(citations: Citation[]): string {
  if (!citations.length) return ""
  // A URL with brackets, spaces or parentheses would end the link early: those are escaped.
  const target = (url: string) =>
    url.replace(/[\s()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)
  const items = citations.map((c, i) => `${i + 1}. [${linkText(c.title || c.url)}](${target(c.url)})`)
  return `\n\nSources:\n${items.join("\n")}`
}

/** The sources a reply's text cites, as Markdown to show after it (citationsMarkdown). */
export function replyCitations(content: readonly AssistantContent[]): string {
  return citationsMarkdown(messageCitations(content))
}
