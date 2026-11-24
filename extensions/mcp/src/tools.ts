import {
  clip,
  type ImageBlock,
  plural,
  type TextBlock,
  type ToolPresenter,
  type ToolResult,
} from "@amira/api"
import type { McpCallResult, McpContent, McpTool } from "./client.ts"

/** Providers cap tool names at 64 characters of [A-Za-z0-9_-]. */
const MAX_NAME = 64

/** `mcp__<server>__<tool>`, made safe for every provider; overlong names keep a hash suffix. */
export function mcpToolName(server: string, tool: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_")
  const full = `mcp__${safe(server)}__${safe(tool)}`
  if (full.length <= MAX_NAME) return full
  const hash = Bun.hash(`${server}\0${tool}`).toString(36).slice(0, 6)
  return `${full.slice(0, MAX_NAME - 7)}_${hash}`
}

export function toolDescription(server: string, tool: McpTool): string {
  const title = tool.title ?? tool.annotations?.title
  const text = tool.description?.trim() || title || `The ${tool.name} tool`
  return `${text}\n(MCP tool "${tool.name}" from server "${server}")`
}

/** MCP requires an object schema; tolerate servers that omit it. */
export function toolSchema(tool: McpTool): Record<string, unknown> {
  const s = tool.inputSchema
  if (!s || typeof s !== "object") return { type: "object", properties: {} }
  return s.type === "object" ? s : { ...s, type: "object" }
}

export function toToolResult(r: McpCallResult): ToolResult {
  const content: (TextBlock | ImageBlock)[] = []
  for (const c of r?.content ?? []) {
    const block = toBlock(c)
    if (block) content.push(block)
  }
  if (!content.length && r?.structuredContent !== undefined) {
    content.push({ type: "text", text: JSON.stringify(r.structuredContent, null, 2) })
  }
  if (!content.length) content.push({ type: "text", text: "(no output)" })
  return r?.isError ? { content, isError: true } : { content }
}

function toBlock(c: McpContent): TextBlock | ImageBlock | undefined {
  switch (c?.type) {
    case "text":
      return { type: "text", text: c.text }
    case "image":
      return { type: "image", data: c.data, mimeType: c.mimeType }
    case "audio":
      return { type: "text", text: `[audio ${c.mimeType}, ${approxBytes(c.data)} bytes, not shown]` }
    case "resource_link": {
      const about = [c.name, c.mimeType, c.description].filter(Boolean).join(", ")
      return { type: "text", text: `Resource: ${c.uri}${about ? ` (${about})` : ""}` }
    }
    case "resource": {
      const res = c.resource
      if (typeof res?.text === "string") return { type: "text", text: `Resource ${res.uri}:\n${res.text}` }
      if (res?.blob && res.mimeType?.startsWith("image/")) {
        return { type: "image", data: res.blob, mimeType: res.mimeType }
      }
      return { type: "text", text: `[resource ${res?.uri ?? "?"} (${res?.mimeType ?? "binary"}), not shown]` }
    }
    default:
      return undefined
  }
}

function approxBytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4)
}

const PRIMARY_ARGS = ["path", "file", "url", "query", "id", "name", "repo", "title", "command"]

/** Presents an MCP tool call cleanly as `<server>/<tool>` with compact args and wrapped full output. */
export function mcpToolPresenter(server: string, tool: McpTool): ToolPresenter {
  const label = `${server}/${tool.name}`
  return {
    verbs: { past: label, running: label },
    summary(args) {
      const entries = Object.entries(args ?? {}).filter(
        ([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
      )
      if (!entries.length) return ""
      const leadIndex = entries.findIndex(([k]) => PRIMARY_ARGS.includes(k))
      const parts = entries.flatMap(([k, v], i) => {
        const text = String(v).replace(/\s+/g, " ").trim()
        if (!text) return []
        return [i === leadIndex ? clip(text, 48) : `${k}=${clip(text, 24)}`]
      })
      if (leadIndex > 0) {
        const lead = String(entries[leadIndex]![1]).replace(/\s+/g, " ").trim()
        if (lead) parts.unshift(clip(lead, 48))
      }
      return clip(parts.join(" · "), 80)
    },
    result(call) {
      if (call.result.isError) return undefined
      const text = call.text.trim()
      if (!text || text === "(no output)") return "no output"
      const lines = text.split("\n")
      if (lines.length === 1) return clip(lines[0]!, 60)
      return `${clip(lines[0]!, 48)} (+${plural(lines.length - 1, "line")})`
    },
    body(call, { detail }) {
      if (detail !== "full" || call.result.isError) return []
      return call.text.split("\n").map((text) => ({ kind: "text", text, wrap: true }))
    },
  }
}
