import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

interface XmlNode {
  tag: string
  attrs: Record<string, string>
  children: XmlNode[]
}

function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function xmlCharacter(code: number): boolean {
  return (
    code === 9 ||
    code === 10 ||
    code === 13 ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  )
}

function decode(text: string): string {
  for (const character of text) requireValid(xmlCharacter(character.codePointAt(0)!), "Invalid XML character")
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }
  requireValid(!/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(text), "Invalid XML entity")
  return text.replace(/&([^;]+);/g, (_, entity: string) => {
    if (entity in entities) return entities[entity]!
    const code = entity.startsWith("#x") ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1))
    requireValid(xmlCharacter(code), "Invalid XML character")
    return String.fromCodePoint(code)
  })
}

// Deliberately only Bun's XML subset: no DTDs, comments, CDATA, recovery or external
// entities. Any unknown/malformed structure is a CI failure, not a retry candidate.
function parseXml(source: string): XmlNode {
  const document: XmlNode = { tag: "document", attrs: {}, children: [] }
  const stack = [document]
  const xml = source.replace(/^<\?xml version="1\.0" encoding="UTF-8"\?>\s*/, "")
  const tokens = /<[^>]*>|[^<]+/gy
  let offset = 0
  for (const match of xml.matchAll(tokens)) {
    requireValid(match.index === offset, "Malformed XML")
    const token = match[0]
    offset += token.length
    const parent = stack.at(-1)!
    if (!token.startsWith("<")) {
      decode(token)
      requireValid(!token.trim() || parent.tag === "failure", "Unexpected XML text")
    } else if (token.startsWith("</")) {
      requireValid(token === `</${parent.tag}>` && stack.length > 1, "Mismatched XML closing tag")
      stack.pop()
    } else {
      const tag =
        /^<(testsuites|testsuite|testcase|failure|skipped|properties|property)((?:\s+[\w-]+="[^"<>]*")*)\s*(\/?)>$/.exec(
          token,
        )
      requireValid(tag, "Unknown or malformed XML element")
      const attrs: Record<string, string> = Object.create(null)
      for (const attr of tag[2]!.matchAll(/([\w-]+)="([^"]*)"/g)) {
        requireValid(!(attr[1]! in attrs), "Duplicate XML attribute")
        attrs[attr[1]!] = decode(attr[2]!)
      }
      const node: XmlNode = { tag: tag[1]!, attrs, children: [] }
      parent.children.push(node)
      if (!tag[3]) stack.push(node)
    }
  }
  requireValid(
    offset === xml.length && stack.length === 1 && document.children.length === 1,
    "Incomplete XML report",
  )
  return document.children[0]!
}

interface TestCase {
  file: string
  name: string
  status: "pass" | "fail" | "skip"
}

interface Report {
  tests: number
  skipped: number
  cases: TestCase[]
  failures: TestCase[]
  files: string[]
}

function count(node: XmlNode, attr: string): number {
  const value = node.attrs[attr]
  requireValid(
    value !== undefined && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)),
    `Invalid ${attr} count`,
  )
  return Number(value)
}

function testFile(file: string | undefined): string {
  requireValid(file && !/[\r\n\0:]/.test(file), "Missing or unsafe test file")
  const normalized = file.replaceAll("\\", "/")
  requireValid(
    !path.posix.isAbsolute(normalized) && !normalized.split("/").some((part) => part === ".." || part === ""),
    "Unsafe test file",
  )
  return normalized.replace(/^\.\//, "")
}

export function parseJUnit(xml: string): Report {
  const root = parseXml(xml)
  requireValid(root.tag === "testsuites" && root.attrs.name === "bun test", "Not a Bun JUnit report")
  const cases: TestCase[] = []
  const files: string[] = []
  function visit(node: XmlNode, file: string, names: string[]): void {
    requireValid(
      node.attrs.errors === undefined || node.attrs.errors === "0",
      "JUnit contains non-test errors",
    )
    if (node.tag === "testcase") {
      requireValid(testFile(node.attrs.file) === file && node.attrs.name, "Invalid testcase identity")
      requireValid(node.children.length <= 1, "Multiple testcase outcomes")
      const outcome = node.children[0]
      requireValid(
        !outcome || ((outcome.tag === "failure" || outcome.tag === "skipped") && !outcome.children.length),
        "Unknown testcase outcome",
      )
      const status = outcome?.tag === "failure" ? "fail" : outcome ? "skip" : "pass"
      requireValid(
        status !== "fail" || (node.attrs.name !== "(unnamed)" && node.attrs.name !== "(worker crashed)"),
        "Hook/worker failure is not safely retryable",
      )
      cases.push({ file, name: [...names, node.attrs.name].join(" > "), status })
      return
    }
    const start = cases.length
    let properties = false
    for (const child of node.children) {
      if (child.tag === "properties") {
        requireValid(
          node.tag === "testsuite" && !properties && !Object.keys(child.attrs).length,
          "Invalid suite properties",
        )
        properties = true
        for (const property of child.children)
          requireValid(
            property.tag === "property" &&
              !property.children.length &&
              Object.keys(property.attrs).length === 2 &&
              property.attrs.name &&
              property.attrs.value !== undefined,
            "Invalid suite property",
          )
        continue
      }
      requireValid(
        child.tag === "testsuite" || (node.tag === "testsuite" && child.tag === "testcase"),
        "Invalid JUnit nesting",
      )
      if (node === root) {
        const nextFile = testFile(child.attrs.file)
        requireValid(!files.includes(nextFile), "Duplicate file suite")
        files.push(nextFile)
        visit(child, nextFile, [])
      } else {
        requireValid(
          testFile(child.attrs.file) === file && child.attrs.name !== undefined,
          "Inconsistent suite identity",
        )
        visit(child, file, child.tag === "testsuite" ? [...names, child.attrs.name] : names)
      }
    }
    const descendants = cases.slice(start)
    requireValid(
      count(node, "tests") === descendants.length &&
        count(node, "failures") === descendants.filter((entry) => entry.status === "fail").length &&
        count(node, "skipped") === descendants.filter((entry) => entry.status === "skip").length,
      "Incomplete/inconsistent JUnit counts",
    )
  }
  visit(root, "", [])
  requireValid(cases.length > 0, "Empty JUnit report")
  return {
    tests: cases.length,
    skipped: cases.filter((entry) => entry.status === "skip").length,
    cases,
    failures: cases.filter((entry) => entry.status === "fail"),
    files,
  }
}

export interface TestRun {
  exitCode: number
  signalCode: string | null
  output: string
  /** Bun's summary is on stderr; stdout can finish draining after it. */
  stderr?: string
}

export function inspectRun(run: TestRun, xml: string): Report {
  requireValid(
    !run.signalCode && (run.exitCode === 0 || run.exitCode === 1),
    "Test process crashed or exited abnormally",
  )
  const report = parseJUnit(xml)
  const output = Bun.stripANSI(run.output).replaceAll("\r\n", "\n")
  const stderr = Bun.stripANSI(run.stderr ?? run.output).replaceAll("\r\n", "\n")
  requireValid(
    !/^# Unhandled error between tests|^\s*\d+ errors?\s*$|worker crashed:|panic:|Bun has crashed|Segmentation fault/m.test(
      output,
    ),
    "Non-test errors in Bun output",
  )
  // JUnit can omit import errors and lost workers. Require the complete human
  // summary too, with matching counts and nothing unexpected after completion.
  const summary =
    /\n (\d+) pass\n(?: (\d+) skip\n)?(?: (\d+) todo\n)? (\d+) fail\n(?:snapshots: (?:\d+ (?:passed|failed)|\+\d+ added)(?:, (?:\d+ (?:passed|failed)|\+\d+ added))*\n)?(?: (?:\d+ snapshots, )?\d+ expect\(\) calls\n)?Ran (\d+) tests? across (\d+) files?\. \[[^\]\n]+\]\n(?:error: script "test" exited with code 1\n)?$/.exec(
      stderr,
    )
  requireValid(summary, "Missing/incomplete Bun summary or unexpected output after report")
  requireValid(
    Number(summary[1]) === report.tests - report.failures.length - report.skipped &&
      Number(summary[2] ?? 0) + Number(summary[3] ?? 0) === report.skipped &&
      Number(summary[4]) === report.failures.length &&
      Number(summary[5]) === report.tests &&
      Number(summary[6]) >= report.files.length,
    "Bun summary does not match JUnit report",
  )
  requireValid(run.exitCode === (report.failures.length ? 1 : 0), "Exit status does not match test failures")
  return report
}

export function warning(test: TestCase): string {
  const data = `${test.file} — ${test.name}`
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
  return `::warning title=flaky test::${data}`
}

async function runCommand(command: string[], cwd: string): Promise<TestRun> {
  const child = Bun.spawn(command, {
    cwd,
    env: process.env,
    windowsHide: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  async function forward(stream: ReadableStream<Uint8Array>, destination: NodeJS.WriteStream) {
    const decoder = new TextDecoder()
    let output = ""
    for await (const chunk of stream) {
      destination.write(chunk)
      output += decoder.decode(chunk, { stream: true })
    }
    return output + decoder.decode()
  }
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    forward(child.stdout, process.stdout),
    forward(child.stderr, process.stderr),
  ])
  return { exitCode, signalCode: child.signalCode, output: `${stdout}\n${stderr}`, stderr }
}

export async function runCiTests(
  options: {
    cwd?: string
    run?: (command: string[], cwd: string) => Promise<TestRun>
    emit?: (line: string) => void
  } = {},
): Promise<number> {
  const cwd = options.cwd ?? process.cwd()
  const run = options.run ?? runCommand
  const emit = options.emit ?? console.log
  const temp = mkdtempSync(path.join(tmpdir(), "amira-ci-junit-"))
  let attempt = 0
  async function execute(args: string[]): Promise<Report> {
    const outfile = path.join(temp, `${attempt++}.xml`)
    const outcome = await run(
      [process.execPath, ...args, "--reporter=junit", `--reporter-outfile=${outfile}`],
      cwd,
    )
    return inspectRun(outcome, readFileSync(outfile, "utf8"))
  }
  try {
    const first = await execute(["run", "test"])
    if (!first.failures.length) return 0
    const files = [...new Set(first.failures.map((entry) => entry.file))]
    let failed = false
    for (const file of files) {
      emit(`Retrying failed test file once: ${file}`)
      // Same cwd, environment, .env loading and bunfig preload as bun run test;
      // explicit ./ paths select only this file. No parallel workers on retries.
      const retry = await execute(["test", `./${file}`])
      const original = first.cases.filter((entry) => entry.file === file)
      const identities = (entries: TestCase[]) => entries.map((entry) => entry.name).sort()
      requireValid(
        retry.files.length === 1 &&
          retry.files[0] === file &&
          JSON.stringify(identities(original)) === JSON.stringify(identities(retry.cases)),
        "Retry did not execute the same test file/cases",
      )
      const originallyFailed = new Set(
        original.filter((entry) => entry.status === "fail").map((entry) => entry.name),
      )
      if (
        retry.failures.length ||
        retry.cases.some((entry) => originallyFailed.has(entry.name) && entry.status !== "pass")
      )
        failed = true
    }
    if (failed) return 1
    for (const failure of first.failures) emit(warning(failure))
    return 0
  } catch (error) {
    emit(`error: CI test retry refused: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

if (import.meta.main) process.exitCode = await runCiTests()
