import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, extname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runCommand } from "@amira/proc"
import type { EditorImage, EditorPart } from "@amira/tui-kit"

/** Also bounds the total image payload of a prompt stored inline in session JSONL. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|svg|heic|tiff?|ico|avif)$/i

export const imageMimeType = (file: string) => MIME_TYPES[extname(file).toLowerCase()]

function checkedImage(bytes: Buffer, name: string, mimeType: string): EditorImage {
  if (bytes.length > MAX_IMAGE_BYTES)
    throw new Error("Images are limited to 5 MB. Resize or compress the image first.")
  const valid =
    mimeType === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mimeType === "image/jpeg"
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : mimeType === "image/gif"
          ? /GIF8[79]a/.test(bytes.subarray(0, 6).toString("ascii"))
          : mimeType === "image/webp"
            ? bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
              bytes.subarray(8, 12).toString("ascii") === "WEBP"
            : false
  if (!valid) throw new Error(`${name} is not a valid PNG, JPEG, GIF or WebP image.`)
  return { name, mimeType, data: bytes.toString("base64") }
}

export function readImage(file: string): EditorImage {
  const mimeType = imageMimeType(file)
  if (!mimeType) throw new Error("Unsupported image format. Use PNG, JPEG, GIF or WebP.")
  const stat = statSync(file)
  if (!stat.isFile()) throw new Error(`${file} is not a file.`)
  if (stat.size > MAX_IMAGE_BYTES)
    throw new Error("Images are limited to 5 MB. Resize or compress the image first.")
  return checkedImage(readFileSync(file), basename(file), mimeType)
}

function localPath(value: string, cwd: string): string {
  return resolve(cwd, /^file:\/\//i.test(value) ? fileURLToPath(value) : value)
}

/**
 * Only a whole paste of image paths is consumed. Prose and other files remain text. Outside
 * Windows a backslash escapes the next character, as macOS terminals drop paths with spaces.
 */
export function pastedImagePaths(
  text: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string[] | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const windows = platform === "win32"
  const unescape = (s: string) => (windows ? s : s.replace(/\\(.)/gs, "$1"))
  // A single unquoted path can contain spaces.
  try {
    const unquoted = /^(["'])(.*)\1$/s.exec(trimmed)?.[2]
    const whole = localPath(unquoted ?? unescape(trimmed), cwd)
    if (IMAGE_EXTENSION.test(whole) && statSync(whole).isFile()) return [whole]
  } catch {}
  const tokenPattern = windows
    ? /^(?:"([^"]+)"|'([^']+)'|(\S+))(?:\s+|$)/
    : /^(?:"([^"]+)"|'([^']+)'|((?:\\.|[^\s\\])+))(?:\s+|$)/s
  const paths: string[] = []
  let rest = trimmed
  while (rest) {
    const token = tokenPattern.exec(rest)
    if (!token) return undefined
    const value = token[1] ?? token[2] ?? unescape(token[3]!)
    try {
      const file = localPath(value, cwd)
      if (!IMAGE_EXTENSION.test(file) || !statSync(file).isFile()) return undefined
      paths.push(file)
    } catch {
      return undefined
    }
    rest = rest.slice(token[0].length)
  }
  return paths.length ? paths : undefined
}

export function imageBytes(parts: readonly EditorPart[]): number {
  return parts.reduce((sum, p) => {
    if (typeof p === "string" || !("image" in p)) return sum
    return sum + Buffer.from(p.image.data, "base64").length
  }, 0)
}

export type ClipboardContent =
  | { type: "image"; image: EditorImage }
  | { type: "text"; text: string }
  | { type: "empty" }
export interface ClipboardOptions {
  cwd: string
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  run?: typeof runCommand
  which?: (tool: string) => string | null
  signal?: AbortSignal
}

const psQuote = (s: string) => `'${s.replaceAll("'", "''")}'`

/** Binary clipboard data goes to a temporary file: @amira/proc collects UTF-8 output. */
export async function readClipboard(opts: ClipboardOptions): Promise<ClipboardContent> {
  const platform = opts.platform ?? process.platform
  const which =
    opts.which ?? ((tool: string) => Bun.which(tool, { PATH: opts.env?.PATH ?? process.env.PATH }))
  const run = opts.run ?? runCommand
  const dir = mkdtempSync(join(tmpdir(), "amira-clipboard-"))
  const file = join(dir, "clipboard.png")
  const call = async (argv: string[]) => {
    const r = await run(argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdoutOnly: true,
      timeoutMs: 5000,
      signal: opts.signal ?? AbortSignal.timeout(6000),
    })
    if (r.timedOut || r.aborted || !r.settled) throw new Error("Clipboard read timed out or was interrupted.")
    return r
  }
  const image = (): ClipboardContent => ({ type: "image", image: readImage(file) })
  try {
    if (platform === "win32") {
      const tool = which("powershell.exe") ?? which("pwsh")
      if (!tool) throw new Error("Image paste needs PowerShell on Windows; it was not found.")
      const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$t = ''
if ([System.Windows.Forms.Clipboard]::ContainsText()) { $t = [System.Windows.Forms.Clipboard]::GetText() }
if ($t.Length -gt 0) { [Console]::Write('text:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))) }
elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) {
  $i = [System.Windows.Forms.Clipboard]::GetImage()
  try { $i.Save(${psQuote(file)}, [System.Drawing.Imaging.ImageFormat]::Png); [Console]::Write('image') }
  finally { $i.Dispose() }
} else { [Console]::Write('empty') }`
      const r = await call([tool, "-NoProfile", "-NonInteractive", "-STA", "-Command", script])
      if (r.exitCode !== 0) throw new Error("Cannot read the Windows clipboard image through PowerShell.")
      const output = r.output.trim()
      if (output.startsWith("text:"))
        return { type: "text", text: Buffer.from(output.slice(5), "base64").toString("utf8") }
      return output === "image" ? image() : { type: "empty" }
    }
    if (platform === "darwin") {
      const osascript = which("osascript")
      if (!osascript)
        throw new Error("Image paste needs osascript or pngpaste on macOS; osascript was not found.")
      const text = await call([
        osascript,
        "-e",
        'try\nreturn the clipboard as text\non error\nerror "No text"\nend try',
      ])
      if (text.exitCode === 0 && text.output.replace(/\r?\n$/, ""))
        return { type: "text", text: text.output.replace(/\r?\n$/, "") }
      const pngpaste = which("pngpaste")
      const script = `set f to open for access POSIX file ${JSON.stringify(file)} with write permission\ntry\nset eof f to 0\nwrite (the clipboard as «class PNGf») to f\nclose access f\non error e\nclose access f\nerror e\nend try`
      const r = await call(pngpaste ? [pngpaste, file] : [osascript, "-e", script])
      if (r.exitCode !== 0)
        throw new Error(
          "No PNG image on the clipboard. On macOS, install pngpaste if image paste is unavailable.",
        )
      return image()
    }
    if (platform === "linux") {
      const wl = which("wl-paste")
      const xclip = which("xclip")
      if (!wl && !xclip)
        throw new Error("Image paste needs wl-paste (Wayland) or xclip (X11); neither was found.")
      for (const [tool, wayland] of [
        [wl, true],
        [xclip, false],
      ] as const) {
        if (!tool) continue
        const types = await call(
          wayland ? [tool, "--list-types"] : [tool, "-selection", "clipboard", "-t", "TARGETS", "-o"],
        )
        if (types.exitCode !== 0) continue
        const targets = types.output.split(/\r?\n/)
        const textType = targets.find(
          (t) => /^text\/plain(?:;|$)/.test(t) || t === "UTF8_STRING" || t === "STRING",
        )
        if (textType) {
          const text = await call(
            wayland
              ? [tool, "--no-newline", "--type", textType]
              : [tool, "-selection", "clipboard", "-t", textType, "-o"],
          )
          if (text.exitCode !== 0) throw new Error("Cannot read clipboard text.")
          if (text.output) return { type: "text", text: text.output }
        }
        if (!targets.includes("image/png")) return { type: "empty" }
        const sh = which("sh")
        if (!sh) throw new Error("Image paste needs sh to save clipboard data; it was not found.")
        const script = wayland
          ? 'exec "$1" --type image/png > "$2"'
          : 'exec "$1" -selection clipboard -t image/png -o > "$2"'
        const r = await call([sh, "-c", script, "amira-clipboard", tool, file])
        if (r.exitCode !== 0) throw new Error("Cannot read the clipboard PNG image.")
        return image()
      }
      throw new Error("Cannot access the clipboard. Check the Wayland or X11 clipboard service.")
    }
    throw new Error(`Image paste is unavailable on ${platform}. Paste an image file path instead.`)
  } finally {
    // A tool still exiting after a timeout can hold the file on Windows; keep its error instead.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {}
  }
}
