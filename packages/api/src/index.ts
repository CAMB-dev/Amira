/** Public API for Amira extensions. Extensions may import only from this package. */
export const API_VERSION = "0.1.0"

export type {
  AssistantMessage,
  ImageBlock,
  JSONSchema,
  Message,
  ModelRef,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@amira/ai"
export * from "./events.ts"
export * from "./extension.ts"
export * from "./process.ts"
export * from "./settings.ts"
export * from "./tools.ts"
export * from "./ui.ts"
