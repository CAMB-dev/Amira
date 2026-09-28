import type { Dialect } from "../dialect.ts"
import { googleGemini } from "./google-gemini.ts"
import { openaiChat } from "./openai-chat.ts"
import { openaiResponses } from "./openai-responses.ts"

/** Dialects available without registration. Each wire protocol adds one entry here. */
export const BUILTIN_DIALECTS: Dialect[] = [openaiChat, openaiResponses, googleGemini]
