import type {
  AssistantMessage,
  CompactResult,
  ImageBlock,
  Message,
  MessageDisplay,
  ModelCaps,
  ModelError,
  ModelInfo,
  ModelRef,
  ModelRequest,
  ReasoningEffort,
  ServerToolBlock,
  Signature,
  StreamEvent,
  TextBlock,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@amira/ai"
import type { ToolResult } from "@amira/api"
import type * as schema from "../../src/remote/schema/messages.ts"
import type { AssertNone, Difference } from "./schema-parity-types.ts"

type Checked =
  | "reasoning"
  | "modelRef"
  | "signature"
  | "usage"
  | "textBlock"
  | "imageBlock"
  | "serverTool"
  | "display"
  | "userMessage"
  | "assistantMessage"
  | "toolMessage"
  | "message"
  | "toolResult"
  | "modelCaps"
  | "modelInfo"
  | "modelRequest"
  | "errorKind"
  | "modelError"
  | "streamEvent"
  | "compactResult"
  | "nullableMessage"
export type MessageSchemaParity = [
  AssertNone<Exclude<keyof typeof schema, Checked> | Exclude<Checked, keyof typeof schema>>,
  AssertNone<Difference<typeof schema.reasoning, ReasoningEffort>>,
  AssertNone<Difference<typeof schema.modelRef, ModelRef>>,
  AssertNone<Difference<typeof schema.signature, Signature>>,
  AssertNone<Difference<typeof schema.usage, Usage>>,
  AssertNone<Difference<typeof schema.textBlock, TextBlock>>,
  AssertNone<Difference<typeof schema.imageBlock, ImageBlock>>,
  AssertNone<Difference<typeof schema.serverTool, ServerToolBlock>>,
  AssertNone<Difference<typeof schema.display, MessageDisplay>>,
  AssertNone<Difference<typeof schema.userMessage, UserMessage>>,
  AssertNone<Difference<typeof schema.assistantMessage, AssistantMessage>>,
  AssertNone<Difference<typeof schema.toolMessage, ToolResultMessage>>,
  AssertNone<Difference<typeof schema.message, Message>>,
  AssertNone<Difference<typeof schema.toolResult, ToolResult>>,
  AssertNone<Difference<typeof schema.modelCaps, ModelCaps>>,
  AssertNone<Difference<typeof schema.modelInfo, ModelInfo>>,
  AssertNone<Difference<typeof schema.modelRequest, ModelRequest>>,
  AssertNone<Difference<typeof schema.errorKind, Exclude<ModelError["kind"], undefined>>>,
  AssertNone<Difference<typeof schema.modelError, ModelError>>,
  AssertNone<Difference<typeof schema.streamEvent, StreamEvent>>,
  AssertNone<Difference<typeof schema.compactResult, CompactResult>>,
  AssertNone<Difference<typeof schema.nullableMessage, Message | null>>,
]
