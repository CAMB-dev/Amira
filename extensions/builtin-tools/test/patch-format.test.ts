import { expect, test } from "bun:test"
import { applyUpdate, parsePatch, type UpdateOperation } from "../src/patch-format.ts"

const wrap = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`
function update(body: string, text: string): string {
  const operation = parsePatch(wrap(`*** Update File: example.ts\n${body}`))[0]!
  return applyUpdate(text, operation as UpdateOperation)
}

test("parses every operation, paths with spaces, and a move", () => {
  const operations = parsePatch(
    wrap(
      "*** Add File: docs/new guide.md\n+# Guide\n+\n*** Delete File: legacy.ts\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n@@ function run()\n-old()\n+newCall()",
    ),
  )
  expect(operations).toEqual([
    { kind: "add", path: "docs/new guide.md", content: "# Guide\n\n" },
    { kind: "delete", path: "legacy.ts" },
    {
      kind: "update",
      path: "src/old.ts",
      moveTo: "src/new.ts",
      hunks: [
        {
          context: "function run()",
          oldLines: ["old()"],
          newLines: ["newCall()"],
          contextLineIndices: [],
          endOfFile: false,
        },
      ],
    },
  ])
})

test("keeps Windows paths literal for the filesystem layer to validate", () => {
  expect(parsePatch(wrap("*** Delete File: C:\\work\\old.ts"))[0]?.path).toBe("C:\\work\\old.ts")
  expect(parsePatch(wrap("*** Add File: ..\\escape.txt\n+data"))[0]?.path).toBe("..\\escape.txt")
})

test("accepts empty patch and empty added file", () => {
  expect(parsePatch("*** Begin Patch\n*** End Patch")).toEqual([])
  expect(parsePatch(wrap("*** Add File: empty.txt"))).toEqual([
    { kind: "add", path: "empty.txt", content: "" },
  ])
})

test("matches exact occurrences before fuzzy occurrences", () => {
  expect(update("@@\n-target\n+changed", "  target\ntarget\n")).toBe("  target\nchanged\n")
})

test("preserves fuzzy context's exact whitespace and punctuation", () => {
  expect(update("@@\n // 'hello' - world\n-old\n+new", "  // ‘hello’ — world \r\nold\r\n")).toBe(
    "  // ‘hello’ — world \r\nnew\r\n",
  )
})

test("applies multiple ordered hunks against original positions", () => {
  expect(update("@@\n-a\n+A\n+extra\n@@\n-c\n+C", "a\nb\nc\n")).toBe("A\nextra\nb\nC\n")
})

test("rejects overlapping hunks with actionable original-file diagnostics", () => {
  expect(() => update("@@\n a\n-b\n+B\n@@\n-b\n+C", "a\nb\nc\n")).toThrow(
    'example.ts: hunk 2 failed to match at or after line 3. Hunks must be ordered and must not overlap.\nExpected context:\n  "b"\nClosest match at line 2 (not applied):\n  2: "b"',
  )
})

test("failure in third hunk never mutates the input", () => {
  const input = "one\ntwo\nthree\n"
  expect(() => update("@@\n-one\n+1\n@@\n-two\n+2\n@@\n-thre\n+3", input)).toThrow(
    'Closest match at line 3 (not applied):\n  3: "three"',
  )
  expect(input).toBe("one\ntwo\nthree\n")
})

test("missing skip context identifies file, hunk, expectation and closest line", () => {
  expect(() => update("@@ function gone()\n-a\n+b", "function go()\na\n")).toThrow(
    'Expected context:\n  "function gone()"\nClosest match at line 1',
  )
})

test("EOF marker selects suffix and refuses an earlier occurrence", () => {
  expect(update("@@\n-old\n+new\n*** End of File", "old\nother\nold\n")).toBe("old\nother\nnew\n")
  expect(() => update("@@\n-old\n+new\n*** End of File", "old\nother\n")).toThrow("hunk 1")
})

test("EOF matching cannot overlap a prior hunk", () => {
  expect(() => update("@@\n-old\n+new\n@@\n-old\n+again\n*** End of File", "old\n")).toThrow("hunk 2")
})

test("preserves mixed endings on untouched and context lines", () => {
  expect(update("@@\n first\n-old\n+new\n third", "first\r\nold\nthird\r\nlast")).toBe(
    "first\r\nnew\nthird\r\nlast",
  )
})

test("LF, CRLF and unterminated files retain their newline state", () => {
  for (const ending of ["\n", "\r\n", ""]) {
    expect(update("@@\n-old\n+new", `old${ending}`)).toBe(`new${ending}`)
  }
  expect(update("@@\n-a\n+A\n+B", "a")).toBe("A\nB")
  expect(update("@@\n-b", "a\r\nb")).toBe("a")
})

test("pure insertions append, including when a skip context is supplied", () => {
  expect(update("@@ function start()\n+extra", "function start()\nlast")).toBe(
    "function start()\nlast\nextra",
  )
  expect(update("@@\n+first\n@@\n+second", "base\n")).toBe("base\nfirst\nsecond\n")
})

test("empty files can be populated and all source lines can be removed", () => {
  expect(update("@@\n+first", "")).toBe("first\n")
  expect(update("@@\n-only", "only\r\n")).toBe("")
  expect(() => update("@@\n-missing\n+new", "")).toThrow("(file is empty)")
})

test("a terminal empty context sentinel is tolerated", () => {
  expect(update("@@\n-old\n+new\n ", "old\n")).toBe("new\n")
})

test("context that resembles a file header is retained as content", () => {
  expect(update("@@\n *** Update File: other.txt\n-old\n+new", "*** Update File: other.txt\nold\n")).toBe(
    "*** Update File: other.txt\nnew\n",
  )
})

// A corpus of common model patches, including explicitly accepted and rejected malformations.
const corpus: { name: string; patch: string; text?: string; expected?: string; error?: string }[] = [
  {
    name: "TypeScript constant",
    patch: wrap("*** Update File: config.ts\n@@\n-export const retries = 2\n+export const retries = 3"),
    text: "export const retries = 2\n",
    expected: "export const retries = 3\n",
  },
  {
    name: "JSON field",
    patch: wrap('*** Update File: package.json\n@@\n-  "private": false,\n+  "private": true,'),
    text: '{\n  "private": false,\n}\n',
    expected: '{\n  "private": true,\n}\n',
  },
  {
    name: "Python method context",
    patch: wrap("*** Update File: app.py\n@@ def run():\n-    pass\n+    return 1"),
    text: "def run():\n    pass\n",
    expected: "def run():\n    return 1\n",
  },
  { name: "Markdown addition", patch: wrap("*** Add File: README.md\n+# Project\n+\n+Run bun test.") },
  { name: "obsolete fixture deletion", patch: wrap("*** Delete File: test/fixtures/old.json") },
  {
    name: "move and rename export",
    patch: wrap(
      "*** Update File: old.ts\n*** Move to: new.ts\n@@\n-export const old = 1\n+export const next = 1",
    ),
    text: "export const old = 1",
    expected: "export const next = 1",
  },
  {
    name: "CSS block",
    patch: wrap("*** Update File: app.css\n@@ .panel {\n-  gap: 4px;\n+  gap: 8px;\n }"),
    text: ".panel {\n  gap: 4px;\n}\n",
    expected: ".panel {\n  gap: 8px;\n}\n",
  },
  {
    name: "shell script append",
    patch: wrap("*** Update File: build.sh\n@@\n+echo done\n*** End of File"),
    text: "#!/bin/sh\n",
    expected: "#!/bin/sh\necho done\n",
  },
  {
    name: "Unicode copy",
    patch: wrap("*** Update File: messages.txt\n@@\n-你好 👋\n+再见 🌍"),
    text: "你好 👋\n",
    expected: "再见 🌍\n",
  },
  {
    name: "Windows transport",
    patch: wrap("*** Update File: src\\app.ts\n@@\n-old\n+new").replaceAll("\n", "\r\n"),
    text: "old\r\n",
    expected: "new\r\n",
  },
  {
    name: "missing initial hunk marker",
    patch: wrap("*** Update File: app.ts\n-old\n+new"),
    text: "old\n",
    expected: "new\n",
  },
  {
    name: "bare empty context",
    patch: wrap("*** Update File: app.ts\n@@\n first\n\n-old\n+new"),
    text: "first\n\nold\n",
    expected: "first\n\nnew\n",
  },
  {
    name: "outer whitespace",
    patch: ` \n ${wrap("*** Update File: app.ts\n@@\n-old\n+new")} \n`,
    text: "old\n",
    expected: "new\n",
  },
  {
    name: "single quoted heredoc",
    patch: `<<'EOF'\n${wrap("*** Update File: app.ts\n@@\n-old\n+new")}\nEOF\n`,
    text: "old\n",
    expected: "new\n",
  },
  {
    name: "double quoted heredoc",
    patch: `<<"EOF"\n${wrap("*** Add File: new.ts\n+export {}\n").replace("\n\n*** End", "\n*** End")}\nEOF`,
  },
  { name: "unquoted heredoc", patch: `<<EOF\n${wrap("*** Delete File: old.ts")}\nEOF` },
  {
    name: "blank after EOF marker",
    patch: wrap("*** Update File: app.ts\n@@\n-old\n+new\n*** End of File\n"),
    text: "old\n",
    expected: "new\n",
  },
  {
    name: "trailing spaces fuzzy match",
    patch: wrap("*** Update File: app.ts\n@@\n-old\n+new"),
    text: "old  \n",
    expected: "new\n",
  },
  {
    name: "indentation fuzzy match",
    patch: wrap("*** Update File: app.ts\n@@\n-old\n+new"),
    text: "  old\n",
    expected: "new\n",
  },
  {
    name: "typographic punctuation",
    patch: wrap("*** Update File: copy.txt\n@@\n-say 'hello' - now\n+done"),
    text: "say ‘hello’ — now\n",
    expected: "done\n",
  },
  {
    name: "nonbreaking internal space",
    patch: wrap("*** Update File: copy.txt\n@@\n-a b\n+c"),
    text: "a\u00a0b\n",
    expected: "c\n",
  },
  { name: "multiple files", patch: wrap("*** Add File: new.ts\n+export {}\n*** Delete File: old.ts") },
  {
    name: "markdown fences rejected",
    patch: `\`\`\`diff\n${wrap("*** Delete File: old.ts")}\n\`\`\``,
    error: "first line",
  },
  { name: "missing end rejected", patch: "*** Begin Patch\n*** Delete File: old.ts", error: "last line" },
  { name: "unprefixed addition rejected", patch: wrap("*** Add File: app.ts\nexport {}"), error: "line 3" },
  { name: "empty update rejected", patch: wrap("*** Update File: app.ts"), error: "empty" },
  { name: "empty hunk rejected", patch: wrap("*** Update File: app.ts\n@@"), error: "does not contain" },
  {
    name: "move without update rejected",
    patch: wrap("*** Update File: old.ts\n*** Move to: new.ts"),
    error: "empty",
  },
  {
    name: "GNU no-newline marker rejected",
    patch: wrap("*** Update File: app.ts\n@@\n-old\n+new\n\\ No newline at end of file"),
    error: "Every update line",
  },
  {
    name: "unsupported environment rejected",
    patch: wrap("*** Environment ID: remote\n*** Delete File: app.ts"),
    error: "Environment ID is unsupported",
  },
  {
    name: "prose after envelope rejected",
    patch: `${wrap("*** Delete File: old.ts")}\nAll done!`,
    error: "last line",
  },
  {
    name: "mismatched heredoc rejected",
    patch: `<<"EOF'\n${wrap("*** Delete File: old.ts")}\nEOF`,
    error: "first line",
  },
  {
    name: "repeated empty hunk rejected",
    patch: wrap("*** Update File: app.ts\n@@\n@@\n-old\n+new"),
    error: "does not contain",
  },
  { name: "missing path rejected", patch: wrap("*** Delete File: "), error: "Expected an Add File" },
]

for (const fixture of corpus) {
  test(`model patch corpus: ${fixture.name}`, () => {
    if (fixture.error) {
      expect(() => parsePatch(fixture.patch)).toThrow(fixture.error)
      return
    }
    const operations = parsePatch(fixture.patch)
    expect(operations.length).toBeGreaterThan(0)
    if (fixture.text !== undefined) {
      const operation = operations[0]!
      expect(operation.kind).toBe("update")
      expect(applyUpdate(fixture.text, operation as UpdateOperation)).toBe(fixture.expected!)
    }
  })
}
