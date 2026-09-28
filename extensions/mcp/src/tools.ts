import type { ImageBlock, TextBlock, ToolResult } from "@amira/api"
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
