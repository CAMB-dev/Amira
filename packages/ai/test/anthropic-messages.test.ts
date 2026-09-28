import { expect, test } from "bun:test"
import { toAnthropicMessages } from "../src/dialects/anthropic-messages.ts"
import { MISSING_RESULT } from "../src/dialects/tool-results.ts"
import type { AssistantContent, AssistantMessage, Message, ToolResultMessage } from "../src/types.ts"

const SIG = "anthropic-messages"
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const assistant = (...content: AssistantContent[]): AssistantMessage => ({
  role: "assistant",
  model: { provider: "p", model: "m" },
  content,
})
const call = (id: string, args: Record<string, unknown> = {}) => ({
  type: "toolCall" as const,
  id,
  name: "read",
  args,
})
const result = (id: string, text = `out ${id}`, isError = false): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read",
  isError,
  content: [{ type: "text", text }],
})
const txt = (text: string) => ({ type: "text" as const, text })

test("merges consecutive same-role messages and drops empty ones", () => {
  const out = toAnthropicMessages([user("a"), user("b"), assistant(), assistant(txt("x")), user("")])
  expect(out).toEqual([
    { role: "user", content: [txt("a"), txt("b")] },
    { role: "assistant", content: [txt("x")] },
  ])
})

test("places tool results in the next user turn in call order", () => {
  const out = toAnthropicMessages([
    user("go"),
    assistant(txt("sure"), call("a", { p: 1 }), call("b")),
    result("b"),
    result("a", "bad", true),
    user("next"),
  ])
  expect(out).toEqual([
    { role: "user", content: [txt("go")] },
    {
      role: "assistant",
      content: [
        txt("sure"),
        { type: "tool_use", id: "a", name: "read", input: { p: 1 } },
        { type: "tool_use", id: "b", name: "read", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: [txt("bad")], is_error: true },
        { type: "tool_result", tool_use_id: "b", content: [txt("out b")] },
        txt("next"),
      ],
    },
  ])
})

test("synthesizes results for orphaned calls and drops stray results", () => {
  const out = toAnthropicMessages([user("go"), result("zzz"), assistant(call("a")), user("stop")])
  expect(out.at(-1)).toEqual({
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "a", content: [txt(MISSING_RESULT)], is_error: true },
      txt("stop"),
    ],
  })
  expect(out).toHaveLength(3)
})

test("sends images as base64 blocks, also inside tool results", () => {
  const img = { type: "image" as const, mimeType: "image/png", data: "AAA" }
  const wire = {
    type: "image" as const,
    source: { type: "base64" as const, media_type: "image/png", data: "AAA" },
  }
  const out = toAnthropicMessages([
    { role: "user", content: [txt("see"), img] },
    assistant(call("a")),
    { role: "toolResult", toolCallId: "a", toolName: "shot", isError: false, content: [img] },
  ])
  expect(out[0]!.content).toEqual([txt("see"), wire])
  expect(out[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "a", content: [wire] }])
})

test("replays signed and redacted thinking unchanged and in place", () => {
  const out = toAnthropicMessages([
    user("q"),
    assistant(
      { type: "thinking", text: "plan", signature: { dialect: SIG, value: "sig1" } },
      txt("before"),
      call("a"),
      { type: "thinking", text: "", redacted: true, signature: { dialect: SIG, value: "enc" } },
      call("b"),
    ),
    result("a"),
    result("b"),
  ])
  expect(out[1]!.content).toEqual([
    { type: "thinking", thinking: "plan", signature: "sig1" },
    txt("before"),
    { type: "tool_use", id: "a", name: "read", input: {} },
    { type: "redacted_thinking", data: "enc" },
    { type: "tool_use", id: "b", name: "read", input: {} },
  ])
})

test("turns foreign and unsigned thinking into text and drops foreign redacted thinking", () => {
  const out = toAnthropicMessages([
    user("q"),
    assistant(
      { type: "thinking", text: "mine?", signature: { dialect: "openai-responses", value: "x" } },
      { type: "thinking", text: "", redacted: true, signature: { dialect: "openai-responses", value: "y" } },
      { type: "thinking", text: "loose" },
      { type: "thinking", text: "empty sig", signature: { dialect: SIG, value: "" } },
      txt("a"),
    ),
  ])
  expect(out[1]!.content).toEqual([
    txt("<thinking>\nmine?\n</thinking>"),
    txt("<thinking>\nloose\n</thinking>"),
    txt("<thinking>\nempty sig\n</thinking>"),
    txt("a"),
  ])
})
