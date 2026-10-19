const job = {
  id: "j1",
  status: "running" as const,
  startedAt: 1,
  command: "mock",
  cwd: "/srv/project",
  contained: true,
  exitCode: null,
  signal: null,
  stopRequested: false,
  outputChars: 0,
}
const invalidParams = [{ unexpected: true }]
const invalidResults = [null]
export const taskFixtures = {
  "jobs.list": { params: {}, result: { jobs: [] }, invalidParams: [{ limit: 101 }], invalidResults },
  "jobs.output": {
    params: { id: "j1" },
    result: { text: "output", from: 4, to: 10, dropped: 4, availableTo: 10, truncated: false },
    invalidParams: [{ id: "j1", maxChars: 32769 }],
    invalidResults: [{ text: "x" }],
  },
  "jobs.stop": { params: { id: "j1" }, result: job, invalidParams: [{}], invalidResults },
  "jobs.wait": {
    params: { id: "j1", timeoutMs: 10 },
    result: { reason: "timeout" as const },
    invalidParams: [{ id: "j1", timeoutMs: -1 }],
    invalidResults: [{ reason: "unknown" }],
  },
  "conversations.list": {
    params: {},
    result: { subagents: [], conversations: [] },
    invalidParams,
    invalidResults,
  },
  "conversations.history": {
    params: { conversationId: "child" },
    result: {
      snapshot: "snapshot",
      sessionGeneration: 1,
      messages: [],
      watermark: { daemonEpoch: "epoch", seq: 0 },
      activity: { events: [] },
    },
    invalidParams: [{}],
    invalidResults: [{ messages: [] }],
  },
  "conversations.focus": {
    params: { conversationId: "child" },
    result: { conversationId: "child", sessionGeneration: 1 },
    invalidParams: [{}],
    invalidResults,
  },
  "conversations.unfocus": { params: {}, result: { sessionGeneration: 1 }, invalidParams, invalidResults },
  "conversations.control": {
    params: { conversationId: "child", action: "pause" as const },
    result: { accepted: true, sessionGeneration: 1 },
    invalidParams: [{ conversationId: "child", action: "start" }],
    invalidResults,
  },
}
