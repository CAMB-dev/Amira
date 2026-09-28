import { type AiOptions, createMockDialect, type MockReply } from "@amira/ai"

/**
 * Hidden test hook for end-to-end tests of the amira command. When AMIRA_TEST_MOCK holds a JSON
 * array of scripted replies (MockReply from @amira/ai), a provider "mock" answers with them in
 * order, so `amira -m mock/any --rpc` runs without a network. Not in --help on purpose.
 */
export function testAiOptions(env: Record<string, string | undefined> = process.env): AiOptions {
  const script = env.AMIRA_TEST_MOCK
  if (!script) return {}
  const replies = JSON.parse(script) as MockReply[]
  if (!Array.isArray(replies)) throw new Error("AMIRA_TEST_MOCK must be a JSON array of mock replies")
  return {
    dialects: [createMockDialect(replies)],
    providers: [{ id: "mock", dialect: "mock", baseUrl: "" }],
  }
}
