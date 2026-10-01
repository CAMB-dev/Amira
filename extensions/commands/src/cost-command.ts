import type { CommandDefinition } from "@amira/api"
import { costReport } from "./format.ts"

export function costCommand(): CommandDefinition {
  return {
    name: "cost",
    aliases: ["usage"],
    description: "Show this session's cost by model",
    run(_args, ctx) {
      ctx.print(
        costReport(
          ctx.session.replies(),
          ctx.session.compactions?.() ?? [],
          ctx.session.sideRequests?.() ?? [],
        ),
      )
    },
  }
}
