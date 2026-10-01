import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

// This is a vocabulary/link audit, not a semantic correctness test. It reads only this checkout.
const root = path.resolve(import.meta.dir, "..")
process.chdir(root)
const pages = ["README.md", "README.zh-CN.md", ...markdown("docs")]
const spans = new Map<string, string[]>()
const absentLinks = new Set<string>()
for (const page of pages) {
  const body = readFileSync(page, "utf8")
  const prose = body.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "")
  for (const match of prose.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)) {
    const token = match[1]!
    const locations = spans.get(token) ?? []
    if (!locations.includes(page)) locations.push(page)
    spans.set(token, locations)
  }
  for (const match of body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1]!.split("#")[0]!
    if (!target || /^[a-z]+:/i.test(target)) continue
    const resolved = path.resolve(path.dirname(page), target)
    if (!existsSync(resolved)) absentLinks.add(path.relative(root, resolved).replaceAll("\\", "/"))
  }
}

let found = 0
let review = 0
console.log("Documentation code-span audit (inline spans; fenced examples require separate review)")
console.log(`Pages: ${pages.length}; distinct spans: ${spans.size}`)
for (const token of [...spans.keys()].sort()) {
  const candidates = evidenceTokens(token)
  let evidence: string | undefined
  let searched = token
  for (const candidate of candidates) {
    const result = Bun.spawnSync(
      [
        "rg",
        "--fixed-strings",
        "--files-with-matches",
        "--",
        candidate,
        "packages",
        "extensions",
        "scripts",
        "package.json",
        "LICENSE",
        "NOTICE",
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    if (result.exitCode === 0) {
      evidence = result.stdout.toString().trim().split(/\r?\n/)[0]
      searched = candidate
      break
    }
    if (result.exitCode !== 1) throw new Error(result.stderr.toString())
  }
  if (evidence) {
    found++
    console.log(`FOUND ${JSON.stringify(token)} => ${JSON.stringify(searched)} in ${evidence}`)
  } else {
    review++
    console.log(`REVIEW ${JSON.stringify(token)} [${spans.get(token)!.join(", ")}]`)
  }
}
console.log(`Summary: ${found} spans have source matches; ${review} need manual review.`)
console.log(`Missing local link targets: ${[...absentLinks].sort().join(", ") || "none"}`)

function markdown(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name).replaceAll("\\", "/")
    if (entry.isDirectory()) return markdown(file)
    return entry.name.endsWith(".md") && entry.name !== "IMPLEMENTATION-REPORT.md" ? [file] : []
  })
}

function evidenceTokens(token: string): string[] {
  const candidates = [token]
  // Normalize displayed shortcuts to key spec names, without treating a hit as proof of binding.
  if (/^(?:Ctrl|Alt|Shift)\+/i.test(token)) candidates.push(token.toLowerCase())
  const slash = /^\/([a-z][a-z-]*)(?:\s|$)/.exec(token)
  if (slash) candidates.push(`/${slash[1]}`, `name: "${slash[1]}"`)
  if (token.startsWith("amira ")) {
    const flags = token.match(/--[a-z][\w-]*|-[A-Za-z]\b/g)
    if (flags?.length) candidates.push(...flags)
    else candidates.push(token.split(" ").slice(0, 3).join(" "))
  }
  if (token.startsWith("tui.")) candidates.push(token.split(".").at(-1)!)
  if (token.includes(":")) candidates.push(token.split(":")[0]!)
  if (/^(?:~\/|\$AMIRA_HOME\/|\.amira\/)/.test(token)) candidates.push(path.basename(token))
  if (/^"[\w-]+"$/.test(token)) candidates.push(token.slice(1, -1))
  return [...new Set(candidates)].filter(Boolean)
}
