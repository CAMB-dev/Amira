import type { CommandDefinition } from "@amira/api"

export function quitCommand(): CommandDefinition {
  return {
    name: "quit",
    aliases: ["exit", "q"],
    description: "Leave Amira",
    run(_args, ctx) {
      ctx.quit()
    },
  }
}
