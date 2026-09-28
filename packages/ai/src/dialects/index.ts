import type { Dialect } from "../dialect.ts"
import { openaiChat } from "./openai-chat.ts"

/** Dialects available without registration. Each wire protocol adds one entry here. */
export const BUILTIN_DIALECTS: Dialect[] = [openaiChat]
