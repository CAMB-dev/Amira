import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { RunResult } from "@amira/proc"
import {
  type ClipboardOptions,
  imageBytes,
  MAX_IMAGE_BYTES,
  pastedImagePaths,
  readClipboard,
  readImage,
} from "../src/image-input.ts"

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXZkAAAAASUVORK5CYII=",
  "base64",
)
const dir = mkdtempSync(join(tmpdir(), "amira-image-input-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const a = join(dir, "image one.png")
const b = join(dir, "two.JPG")
writeFileSync(a, PNG)
writeFileSync(b, Buffer.from([255, 216, 255, 217]))
writeFileSync(join(dir, "code.ts"), "code")
mkdirSync(join(dir, "folder.png"))

test("pasted paths accept spaces, quotes, Windows paths and file URIs", () => {
  expect(pastedImagePaths(a, dir)).toEqual([a])
  expect(pastedImagePaths(`"${a}" '${b}'\n`, dir)).toEqual([a, b])
  expect(pastedImagePaths(`${pathToFileURL(a)}\n${pathToFileURL(b)}`, dir)).toEqual([a, b])
  expect(pastedImagePaths('"image one.png" two.JPG', dir)).toEqual([a, b])
  if (process.platform === "win32") expect(pastedImagePaths(`"${a.replaceAll("/", "\\")}"`, dir)).toEqual([a])
})

test("prose, non-images, missing files, malformed URIs and directories stay text", () => {
  for (const text of [
    "look at image one.png",
    "code.ts",
    "missing.png",
    "folder.png",
    '"unclosed.png',
    "file://%bad.png",
    '"image one.png" missing.png',
    "",
  ]) {
    expect(pastedImagePaths(text, dir)).toBeUndefined()
  }
})

test("image files are encoded with their name and MIME type; formats and size are checked", () => {
  expect(readImage(a)).toEqual({ name: "image one.png", mimeType: "image/png", data: PNG.toString("base64") })
  expect(readImage(b).mimeType).toBe("image/jpeg")
  for (const [name, bytes, mime] of [
    ["a.gif", Buffer.from("GIF89a"), "image/gif"],
    ["a.webp", Buffer.from("RIFF0000WEBP"), "image/webp"],
  ] as const) {
    const file = join(dir, name)
    writeFileSync(file, bytes)
    expect(readImage(file).mimeType).toBe(mime)
  }
  const svg = join(dir, "vector.svg")
  writeFileSync(svg, "<svg/>")
  expect(pastedImagePaths(svg, dir)).toEqual([svg])
  expect(() => readImage(svg)).toThrow("Unsupported image format")
  const fake = join(dir, "fake.png")
  writeFileSync(fake, "text")
  expect(() => readImage(fake)).toThrow("not a valid")
  const large = join(dir, "large.png")
  writeFileSync(large, Buffer.alloc(MAX_IMAGE_BYTES + 1))
  expect(() => readImage(large)).toThrow("5 MB")
  expect(imageBytes(["text", { paste: "paste" }, { image: readImage(a) }, { image: readImage(a) }])).toBe(
    PNG.length * 2,
  )
})

const result = (output = "", exitCode = 0): RunResult => ({
  output,
  exitCode,
  signalCode: null,
  timedOut: false,
  aborted: false,
  settled: true,
  contained: true,
})
const which =
  (...tools: string[]) =>
  (tool: string) =>
    tools.includes(tool) ? tool : null

test("Windows reader uses PowerShell STA, saves PNG through a fake runner and cleans up", async () => {
  let file = ""
  const run: NonNullable<ClipboardOptions["run"]> = async (argv, opts) => {
    expect(argv.slice(0, 5)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command"])
    expect(opts.stdoutOnly).toBe(true)
    expect(opts.timeoutMs).toBe(5000)
    expect(opts.cwd).toBe(dir)
    const script = argv[5]!
    expect(script.indexOf("ContainsText")).toBeLessThan(script.indexOf("ContainsImage"))
    file = /\.Save\('((?:[^']|'')*)'/.exec(script)![1]!.replaceAll("''", "'")
    writeFileSync(file, PNG)
    return result("image")
  }
  expect(await readClipboard({ cwd: dir, platform: "win32", which: which("powershell.exe"), run })).toEqual({
    type: "image",
    image: { name: "clipboard.png", mimeType: "image/png", data: PNG.toString("base64") },
  })
  expect(existsSync(file)).toBe(false)
})

test("Windows clipboard text takes priority and empty clipboard adds nothing", async () => {
  for (const output of [`text:${Buffer.from("hello\n world").toString("base64")}`, "empty"]) {
    const got = await readClipboard({
      cwd: dir,
      platform: "win32",
      which: which("pwsh"),
      run: async () => result(output),
    })
    expect(got).toEqual(output === "empty" ? { type: "empty" } : { type: "text", text: "hello\n world" })
  }
})

for (const pngpaste of [true, false]) {
  test(`macOS clipboard reads text first, then ${pngpaste ? "pngpaste" : "osascript PNG data"}`, async () => {
    const calls: string[][] = []
    let file = ""
    const run: NonNullable<ClipboardOptions["run"]> = async (argv) => {
      calls.push(argv)
      if (calls.length === 1) return result("", 1)
      file = pngpaste ? argv[1]! : JSON.parse(/POSIX file (".*?") with/.exec(argv[2]!)![1]!)
      writeFileSync(file, PNG)
      return result()
    }
    const got = await readClipboard({
      cwd: dir,
      platform: "darwin",
      which: which("osascript", ...(pngpaste ? ["pngpaste"] : [])),
      run,
    })
    expect(got.type).toBe("image")
    expect(calls[0]![2]).toContain("clipboard as text")
    expect(existsSync(file)).toBe(false)
  })
}

for (const tool of ["wl-paste", "xclip"]) {
  test(`Linux ${tool} reader saves binary PNG with a fake runner`, async () => {
    const calls: string[][] = []
    let file = ""
    const run: NonNullable<ClipboardOptions["run"]> = async (argv) => {
      calls.push(argv)
      if (calls.length === 1) return result("image/png\n")
      expect(argv[0]).toBe("sh")
      expect(argv[2]).toContain(tool === "wl-paste" ? "--type image/png" : "-t image/png -o")
      file = argv.at(-1)!
      writeFileSync(file, PNG)
      return result()
    }
    const got = await readClipboard({ cwd: dir, platform: "linux", which: which(tool, "sh"), run })
    expect(got.type).toBe("image")
    expect(calls).toHaveLength(2)
    expect(existsSync(file)).toBe(false)
  })
  test(`Linux ${tool} prefers text even when an image target exists`, async () => {
    let calls = 0
    const got = await readClipboard({
      cwd: dir,
      platform: "linux",
      which: which(tool, "sh"),
      run: async () => result(++calls === 1 ? "text/plain\nUTF8_STRING\nimage/png" : " hi\n"),
    })
    expect(got).toEqual({ type: "text", text: " hi\n" })
    expect(calls).toBe(2)
  })
}

test("macOS text takes priority without calling pngpaste", async () => {
  let calls = 0
  expect(
    await readClipboard({
      cwd: dir,
      platform: "darwin",
      which: which("osascript", "pngpaste"),
      run: async () => {
        calls++
        return result("hi\n")
      },
    }),
  ).toEqual({ type: "text", text: "hi" })
  expect(calls).toBe(1)
})

test("Linux falls back from an unavailable Wayland clipboard to X11", async () => {
  const got = await readClipboard({
    cwd: dir,
    platform: "linux",
    which: which("wl-paste", "xclip"),
    run: async (argv) => result(argv[0] === "wl-paste" ? "" : "UTF8_STRING", argv[0] === "wl-paste" ? 1 : 0),
  })
  expect(got).toEqual({ type: "text", text: "UTF8_STRING" })
})

test("missing clipboard tools and failed reads have actionable errors", async () => {
  for (const [platform, message] of [
    ["win32", "PowerShell"],
    ["darwin", "osascript"],
    ["linux", "wl-paste"],
  ] as const) {
    await expect(
      readClipboard({
        cwd: dir,
        platform,
        which: which(),
        run: async () => {
          throw new Error("must not run")
        },
      }),
    ).rejects.toThrow(message)
  }
  await expect(
    readClipboard({ cwd: dir, platform: "win32", which: which("pwsh"), run: async () => result("", 1) }),
  ).rejects.toThrow("Cannot read")
  await expect(
    readClipboard({
      cwd: dir,
      platform: "win32",
      which: which("pwsh"),
      run: async () => ({ ...result(), timedOut: true }),
    }),
  ).rejects.toThrow("timed out")
})

test("oversized clipboard images are refused and their temporary files are removed", async () => {
  let file = ""
  await expect(
    readClipboard({
      cwd: dir,
      platform: "linux",
      which: which("wl-paste", "sh"),
      run: async (argv) => {
        if (argv[0] === "wl-paste") return result("image/png")
        file = argv.at(-1)!
        writeFileSync(file, Buffer.alloc(MAX_IMAGE_BYTES + 1))
        return result()
      },
    }),
  ).rejects.toThrow("5 MB")
  expect(existsSync(file)).toBe(false)
})
