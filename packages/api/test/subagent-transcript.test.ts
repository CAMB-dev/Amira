import { expect, test } from "bun:test"
import { subagentOwnMessages } from "@amira/api/internal/subagent-transcript"
import { type Message, type SubagentInfo, subagentTranscriptText } from "../src/index.ts"

const info: SubagentInfo = {
  id: "child",
  parentSessionId: "root",
  depth: 1,
  role: "coder",
  title: "Build it",
  task: "Implement it",
  status: "running",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}
const assistant = (name: string): Message => ({
  role: "assistant",
  model: { provider: "mock", model: "m" },
  content: [{ type: "toolCall", id: name, name, args: { command: "bun test" } }],
})

test("fork transcripts retain the original task and every child's tool group across automatic notices and follow-ups", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "Parent task" }] },
    assistant("parent_tool"),
    { role: "user", content: [{ type: "text", text: info.task }] },
    assistant("monitor"),
    {
      role: "user",
      content: [{ type: "text", text: "Monitor job1 output" }],
      display: { text: "Output", origin: "job" },
    },
    assistant("bash"),
    { role: "user", content: [{ type: "text", text: "Continue" }] },
    assistant("read"),
  ]
  expect(subagentOwnMessages(info, messages)).toEqual(messages.slice(2))
  const text = subagentTranscriptText(info, messages, [])
  expect(text).toContain("Implement it")
  expect(text).toContain("monitor bun test")
  expect(text).toContain("bash bun test")
  expect(text).toContain("read bun test")
  expect(text).not.toContain("parent_tool")
})

test("a repeated follow-up task does not discard the first child's turn", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: info.task }] },
    assistant("monitor"),
    { role: "user", content: [{ type: "text", text: info.task }] },
    assistant("bash"),
  ]
  expect(subagentOwnMessages(info, messages)).toEqual(messages)
  expect(subagentTranscriptText(info, messages, [])).toContain("monitor bun test")
})

test("when compaction has removed the task, notices and follow-ups are not mistaken for new boundaries", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "Compacted context" }] },
    assistant("monitor"),
    {
      role: "user",
      content: [{ type: "text", text: "output" }],
      display: { text: "Monitor", origin: "job" },
    },
    { role: "user", content: [{ type: "text", text: "Continue" }] },
  ]
  expect(subagentOwnMessages(info, messages)).toEqual(messages)
  expect(subagentTranscriptText(info, messages, [])).toContain("Implement it")
  expect(subagentTranscriptText(info, messages, [])).toContain("monitor bun test")
})
