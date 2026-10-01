import type { AssistantMessage, ServerToolBlock, Usage } from "@amira/ai"
import * as shared from "@amira/ai-shared"

// One implementation, shared with @amira/ai through a dependency-free leaf, typed with ai's types.

/** A usage value with all token counters at zero. */
export const emptyUsage: () => Usage = shared.emptyUsage

/** Adds token and search usage, keeping cost unknown when an included search was not priced. */
export const addUsage: (a: Usage, b: Usage) => Usage = shared.addUsage

/** A reported search or server search block whose total cost could not be priced. */
export const hasUnpricedSearch: (message: Pick<AssistantMessage, "content" | "usage">) => boolean =
  shared.hasUnpricedSearch

/** "Web search: \"node lts\"", "Web search opened https://…", for notes and frontends. */
export const describeServerTool: (b: Pick<ServerToolBlock, "name" | "input">) => string =
  shared.describeServerTool

/** A server tool's call as a short note for a model that cannot take its provider-native item. */
export const serverToolText: (b: ServerToolBlock) => string = shared.serverToolText
