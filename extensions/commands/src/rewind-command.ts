import {
  type ExtensionAPI,
  type FileRewindPlan,
  plural,
  type SessionControl,
  type UserMessage,
} from "@amira/api"
import { oneLine } from "./command-utils.ts"

type RewindPick = { message: UserMessage; index: number }

/** User turns the rewind picker can return to, newest first. */
function rewindPicks(session: SessionControl): RewindPick[] {
  return session
    .messages()
    .map((message, index) => ({ message, index }))
    .filter((pick): pick is RewindPick => pick.message.role === "user" && !pick.message.display?.origin)
    .reverse()
}

/** Whether rewinding restores files: as the picker's default, only when there is something to restore. */
function restoresFiles(plan: FileRewindPlan | undefined): boolean {
  return !!plan && plan.enabled && (plan.owner !== "core" || plan.restored + plan.removed > 0)
}

function directRewindPreview(
  pick: RewindPick,
  messagesCut: number,
  plan: FileRewindPlan | undefined,
): string {
  const text =
    pick.message.display?.text ??
    pick.message.content.map((block) => (block.type === "text" ? block.text : "")).join("")
  const lines = [
    `Message: ${oneLine(text || "(image)", 100)}`,
    `This removes ${messagesCut} message${messagesCut === 1 ? "" : "s"} from the active conversation.`,
  ]
  if (!plan || !restoresFiles(plan)) lines.push("Files will not be restored.")
  else {
    lines.push(
      plan.owner === "core"
        ? `Files: ${plan.restored} restored, ${plan.removed} removed.`
        : `Files: ${plan.owner}.`,
      plan.conflicts.length
        ? `Conflicts (the rewind is refused until they are resolved):\n${plan.conflicts.join("\n")}`
        : "Conflicts: none.",
    )
  }
  if (plan?.note) lines.push(plan.note)
  return lines.join("\n")
}

function parseDirectRewind(args: string): { nth: number; yes: boolean; conversationOnly: boolean } {
  const parts = args.trim().split(/\s+/)
  const number = Number(parts[0])
  const flags = parts.slice(1)
  const yes = flags.includes("--yes")
  const conversationOnly = flags.includes("--conversation-only")
  const validFlags = flags.every((f) => f === "--yes" || f === "--conversation-only")
  const uniqueFlags = new Set(flags).size === flags.length
  if (!Number.isSafeInteger(number) || number < 1 || !validFlags || !uniqueFlags)
    throw new Error("Usage: /rewind <n> [--yes]")
  return { nth: number, yes, conversationOnly }
}

function ordinal(number: number): string {
  const lastTwo = number % 100
  const suffix =
    lastTwo >= 11 && lastTwo <= 13
      ? "th"
      : number % 10 === 1
        ? "st"
        : number % 10 === 2
          ? "nd"
          : number % 10 === 3
            ? "rd"
            : "th"
  return `${number}${suffix}`
}

/** Registers the rewind commands in their original order. */
export function registerRewindCommands(api: ExtensionAPI): void {
  api.registerCommand({
    name: "rewind",
    description: "Rewind to an earlier user message",
    args: { hint: "[n] [--yes]" },
    async run(args, ctx) {
      const rewind = ctx.session.rewind
      if (!rewind) throw new Error("Rewind is not available for this session")
      const picks = rewindPicks(ctx.session)
      if (!picks.length) throw new Error("Nothing to rewind to yet")

      if (!args.trim()) {
        // The frontend's own picker, the one double Esc opens: fork, file choice and the
        // prompt put back in the editor all stay in one place.
        if (!ctx.openRewind)
          throw new Error(
            "Use /rewind <n> [--yes] outside the terminal UI; n is the n-th most recent user message",
          )
        if (!ctx.openRewind()) throw new Error("Cannot open the rewind picker now; wait for the turn to end")
        return
      }

      const { nth, yes, conversationOnly } = parseDirectRewind(args)
      const pick = picks[nth - 1]
      if (!pick) throw new Error(`There are only ${picks.length} user messages to rewind to`)
      const plan = ctx.session.planRewind?.(pick.index)
      const restoreFiles = !conversationOnly && !!plan && restoresFiles(plan)
      if (!yes) {
        if (ctx.frontend === "print")
          throw new Error("Print mode cannot confirm rewind; repeat this command with --yes to proceed")
        const preview = directRewindPreview(
          pick,
          ctx.session.messages().length - pick.index,
          conversationOnly ? undefined : plan,
        )
        const conflictHint =
          restoreFiles && plan && plan.conflicts.length > 0
            ? `\nOr run /rewind ${nth} --conversation-only to rewind without restoring files.`
            : ""
        const confirmed = await ctx.ui.confirm(
          `Rewind to before the ${ordinal(nth)} most recent user message?`,
          `${preview}${conflictHint}`,
          { signal: ctx.signal, tone: "warning" },
        )
        if (!confirmed) {
          ctx.print("Rewind cancelled.")
          return
        }
      }
      await rewind(pick.index, { restoreFiles, signal: ctx.signal })
      const files =
        !plan || !restoreFiles
          ? "Files were not restored."
          : plan.owner === "core"
            ? `Restored ${plan.restored} file${plan.restored === 1 ? "" : "s"}; removed ${plan.removed}.`
            : `${plan.owner} completed.`
      ctx.print(`Rewound the conversation to before the ${ordinal(nth)} most recent user message. ${files}`)
    },
  })
  api.registerCommand({
    name: "rewind-prune",
    description: "Discard this session's captured file history and free its storage",
    args: { hint: "[--yes]" },
    run: async (args, ctx) => {
      if (!ctx.session.pruneFileHistory) throw new Error("File rewind storage is not available")
      const trimmed = args.trim()
      if (trimmed && trimmed !== "--yes") throw new Error("Usage: /rewind-prune [--yes]")
      if (trimmed !== "--yes") {
        if (ctx.frontend === "print")
          throw new Error("Print mode cannot confirm pruning file history; repeat with --yes to proceed")
        const confirmed = await ctx.ui.confirm(
          "Discard captured file history?",
          "Earlier captured file changes can no longer be restored.",
          { signal: ctx.signal, tone: "warning" },
        )
        if (!confirmed) {
          ctx.print("Prune cancelled.")
          return
        }
      }
      const result = ctx.session.pruneFileHistory()
      if (result.files === 0) {
        ctx.print("No captured file history to prune.")
        return
      }
      ctx.print(
        `Pruned ${plural(result.files, "file image")} (${result.bytes} bytes). Earlier captured changes can no longer be restored.`,
      )
    },
  })
}
