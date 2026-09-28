import TurndownService from "turndown"

/** Elements that never hold readable text. */
const DROPPED = [
  "head",
  "title",
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "nav",
  "button",
  "input",
  "select",
  "textarea",
  "link",
  "meta",
] as const

/** The part of a DOM element the rules use (there is no DOM lib in this project). */
interface El {
  getAttribute(name: string): string | null
}

function service(base: string): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
  })
  td.remove([...DROPPED])
  const absolute = (href: string | null) => {
    if (!href) return ""
    try {
      return new URL(href, base).href
    } catch {
      return href
    }
  }
  td.addRule("links", {
    filter: (node) => node.nodeName === "A" && !!node.getAttribute("href"),
    replacement: (content, node) => {
      const text = content.trim().replace(/\s*\n\s*/g, " ")
      const raw = ((node as unknown as El).getAttribute("href") ?? "").trim()
      if (!text) return ""
      // In-page anchors and script links lead nowhere useful.
      if (raw.startsWith("#") || /^(javascript|data):/i.test(raw)) return text
      return `[${text}](${absolute(raw)})`
    },
  })
  td.addRule("images", {
    filter: "img",
    replacement: (_content, node) => {
      const alt = ((node as unknown as El).getAttribute("alt") ?? "").trim().replace(/\s+/g, " ")
      const src = absolute((node as unknown as El).getAttribute("src"))
      if (!alt || /^data:/i.test(src)) return ""
      return `![${alt}](${src})`
    },
  })
  return td
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    return named[e.toLowerCase()] ?? m
  })
}

/** The page's <title>, if any. */
export function htmlTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = m
    ? decodeEntities(m[1] as string)
        .replace(/\s+/g, " ")
        .trim()
    : ""
  return title || undefined
}

/**
 * Converts an HTML page to Markdown: scripts, styles, navigation and form controls are
 * dropped, links and images are made absolute against `base`.
 */
export function htmlToMarkdown(html: string, base: string): string {
  // Dropped anyway; cutting them out first keeps the DOM turndown builds small (on large
  // pages scripts and inline SVG are often half the bytes).
  const lean = html
    .replace(/<(script|style|svg|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
  const md = service(base).turndown(lean)
  return md
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
