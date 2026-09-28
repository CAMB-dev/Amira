import { expect, test } from "bun:test"
import { createAi } from "../src/client.ts"
import { collect } from "../src/dialect.ts"
import { MISSING_RESULT, toChatMessages } from "../src/dialects/openai-chat-messages.ts"
import type { AssistantContent, AssistantMessage, Message, ToolResultMessage } from "../src/types.ts"
import { fakeFetch, type Seen, sseResponse } from "./helpers.ts"

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const assistant = (...content: AssistantContent[]): AssistantMessage => ({
  role: "assistant",
  model: { provider: "p", model: "m" },
  content,
})
const call = (id: string, name = "read") => ({ type: "toolCall" as const, id, name, args: {} })
const result = (id: string, text = `out ${id}`): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read",
  isError: false,
  content: [{ type: "text", text }],
})
const wireCall = (id: string, name = "read") => ({
  id,
  type: "function" as const,
  function: { name, arguments: "{}" },
})

test("drops an assistant message with no text and no tool calls", () => {
  const out = toChatMessages("", [
    user("hi"),
    assistant(),
    user("again"),
    assistant({ type: "thinking", text: "t" }),
  ])
  expect(out).toEqual([
    { role: "user", content: "hi" },
    { role: "user", content: "again" },
  ])
})

test("sends null content only alongside tool calls", () => {
  const out = toChatMessages("", [assistant(call("a")), result("a"), assistant({ type: "text", text: "ok" })])
  expect(out).toEqual([
    { role: "assistant", content: null, tool_calls: [wireCall("a")] },
    { role: "tool", tool_call_id: "a", content: "out a" },
    { role: "assistant", content: "ok" },
  ])
})

test("synthesizes results for calls that never completed", () => {
  const out = toChatMessages("", [assistant(call("a"), call("b")), result("b"), user("stop")])
  expect(out).toEqual([
    { role: "assistant", content: null, tool_calls: [wireCall("a"), wireCall("b")] },
    { role: "tool", tool_call_id: "a", content: MISSING_RESULT },
    { role: "tool", tool_call_id: "b", content: "out b" },
    { role: "user", content: "stop" },
  ])
})

test("moves out-of-order results directly after their call", () => {
  const out = toChatMessages("", [assistant(call("a"), call("b")), user("steer"), result("b"), result("a")])
  expect(out).toEqual([
    { role: "assistant", content: null, tool_calls: [wireCall("a"), wireCall("b")] },
    { role: "tool", tool_call_id: "a", content: "out a" },
    { role: "tool", tool_call_id: "b", content: "out b" },
    { role: "user", content: "steer" },
  ])
})

test("drops results that have no preceding call", () => {
  const out = toChatMessages("", [
    result("x"),
    user("hi"),
    result("a"),
    assistant(call("a")),
    result("a", "late"),
  ])
  expect(out).toEqual([
    { role: "user", content: "hi" },
    { role: "assistant", content: null, tool_calls: [wireCall("a")] },
    { role: "tool", tool_call_id: "a", content: "late" },
  ])
})

test("pairs a repeated call id with its own result", () => {
  const out = toChatMessages("", [
    assistant(call("a")),
    result("a", "one"),
    assistant(call("a")),
    result("a", "two"),
  ])
  expect(out.filter((m) => m.role === "tool").map((m) => m.content)).toEqual(["one", "two"])
})

const screenshot: ToolResultMessage = {
  role: "toolResult",
  toolCallId: "s",
  toolName: "screenshot",
  isError: false,
  content: [
    { type: "text", text: "captured" },
    { type: "image", mimeType: "image/png", data: "AAAA" },
  ],
}

test("keeps a placeholder for tool-result images when the model has no image support", () => {
  const out = toChatMessages("", [assistant(call("s", "screenshot")), screenshot])
  expect(out.slice(1)).toEqual([{ role: "tool", tool_call_id: "s", content: "captured\n[image: image/png]" }])
})

test("sends tool-result images in a user message after the tool messages", () => {
  const out = toChatMessages("", [assistant(call("s", "screenshot"), call("b")), screenshot, result("b")], {
    images: true,
  })
  expect(out.slice(1)).toEqual([
    { role: "tool", tool_call_id: "s", content: "captured\n[image: image/png, sent in the next message]" },
    { role: "tool", tool_call_id: "b", content: "out b" },
    {
      role: "user",
      content: [
        { type: "text", text: "Images from the screenshot result (s):" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    },
  ])
})

test("sends user images as parts and joins multiple text blocks", () => {
  const out = toChatMessages("", [
    {
      role: "user",
      content: [
        { type: "text", text: "look " },
        { type: "image", mimeType: "image/jpeg", data: "BBBB" },
      ],
    },
    {
      role: "user",
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    },
  ])
  expect(out).toEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "look " },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } },
      ],
    },
    { role: "user", content: "ab" },
  ])
})

test("the dialect sends tool-result images when the model supports images", async () => {
  const seen: Seen = {}
  const ai = createAi({
    fetch: fakeFetch(() => sseResponse([]), seen),
    providers: [
      {
        id: "test",
        dialect: "openai-chat",
        baseUrl: "http://test",
        models: [{ id: "vision", caps: { images: true } }],
      },
    ],
  })
  await collect(
    ai.stream({
      model: ai.model("test/vision"),
      systemPrompt: "",
      messages: [assistant(call("s", "screenshot")), screenshot],
      tools: [],
    }),
  )
  expect(seen.body.messages.at(-1).role).toBe("user")
})
