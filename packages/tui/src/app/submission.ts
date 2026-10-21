// Owns submission validation and routing to commands, skills, input handlers or the outbox.
import { isNoModel } from "@amira/ai"
import {
  type AgentPort,
  type CommandHost,
  type CommandRunOptions,
  frontendIdentity,
  parseCommandLine,
} from "@amira/core"
import type { Editor, EditorPart } from "@amira/tui-kit"
import { bindLocalCommandContext } from "../../../core/src/frontend/operations.ts"
import { imageBytes, MAX_IMAGE_BYTES } from "../image-input.ts"
import type { PromptHistory } from "../prompt-history.ts"
import type { TranscriptView } from "../view.ts"
import type { CommandRunner, CommandRunnerOptions } from "./command-runner.ts"
import type { Composer } from "./composer.ts"
import type { DisplayModel } from "./frontend-display.ts"
import type { Outbox, WhileWorking } from "./outbox.ts"

interface SubmissionDeps {
  agent: () => { model: DisplayModel }
  editor: Pick<Editor, "setParts" | "clear" | "getText" | "getParts" | "getDisplayText">
  history: Pick<PromptHistory, "add">
  commands?: CommandHost
  skillLine?: CommandHost["skillLine"]
  port?: AgentPort
  captureFrontend?: CommandRunnerOptions["captureFrontend"]
  bindCommandFrontend?: (invocationId: string, options: CommandRunOptions) => () => void
  composer: Pick<Composer, "clipboardPending" | "resetHistory">
  commandRunner: Pick<CommandRunner, "run">
  outbox: Pick<Outbox, "prepare" | "dispatch"> & Partial<Pick<Outbox, "commandSend">>
  view: Pick<TranscriptView, "notice" | "commandEcho" | "requestRender">
  composerView?: () => SubmissionDeps["view"]
  enterDoes: WhileWorking
  notice?: string
  focusedSubmit?: (text: string, parts: EditorPart[], display?: string) => boolean
  context: Parameters<CommandHost["runSkill"]>[1]
}

/** Validates drafts before accepting them; every send key uses the same routing and history. */
export function createSubmission(deps: SubmissionDeps) {
  const { editor, history, commands, composer, commandRunner, outbox, view, enterDoes } = deps

  /** Whether no provider is configured: from the session when it says, else from the CLI's notice. */
  function noProviders(): boolean {
    const providers = commands?.control.providers
    if (providers) {
      try {
        return providers().length === 0
      } catch {}
    }
    return deps.notice?.startsWith("No providers") ?? false
  }

  /**
   * Sending while no model is picked would only fail: the message stays in the editor, and a
   * notice says what to do first.
   */
  function noModelYet(parts: EditorPart[]): boolean {
    if (!isNoModel(deps.agent().model)) return false
    editor.setParts(parts)
    view.notice(
      "error",
      noProviders()
        ? "No providers configured: add one with /provider add, then pick a model with /model. Your message is still in the input."
        : "No model selected: pick one with /model. Your message is still in the input.",
    )
    return true
  }

  /**
   * Enter and the other send keys: runs a slash command at once, sends, or while a turn runs
   * steers it (D29) or queues the message after it, as `how` says. `parts` is the editor
   * content as typed, folded pastes apart, for the prompt history; `display` shows the pastes
   * as their placeholders in the transcript.
   */
  function submit(text: string, parts: EditorPart[] = [text], display?: string, how = enterDoes) {
    const trimmed = text.trim()
    const hasImages = parts.some((p) => typeof p !== "string" && "image" in p)
    if (!composer.clipboardPending && deps.focusedSubmit?.(text, parts, display)) {
      view.requestRender()
      return
    }
    if (
      composer.clipboardPending ||
      (hasImages &&
        (imageBytes(parts) > MAX_IMAGE_BYTES ||
          (!isNoModel(deps.agent().model) && !deps.agent().model.caps?.images)))
    ) {
      editor.setParts(parts)
      const visible = deps.composerView?.() ?? view
      visible.notice(
        "warning",
        composer.clipboardPending
          ? "Clipboard paste is still loading. Send the message once it finishes."
          : imageBytes(parts) > MAX_IMAGE_BYTES
            ? "Images in a message are limited to 5 MB total. Remove an attachment or resize it first."
            : "This model does not support images. Pick an image-capable model with /model or remove the attachments. Your message is still in the input.",
      )
      visible.requestRender()
      return
    }
    if (!trimmed && !hasImages) return
    editor.clear()
    history.add(parts)
    composer.resetHistory()
    const message = outbox.prepare(trimmed, parts, display)
    const commandPort = deps.port && deps.port.supportedOperations?.includes("command.run") !== false
    if (!hasImages && (commands || commandPort) && parseCommandLine(trimmed))
      void commandRunner.run(trimmed, message.seq)
    else if (!hasImages && (commands?.skillLine(trimmed) || deps.skillLine?.(trimmed)))
      runSkill(trimmed, message.seq)
    else if (!hasImages && commands?.inputLine(trimmed)) runInput(trimmed, display, message.seq)
    else outbox.dispatch(message, parts, how)
    view.requestRender()
  }

  /** Sends what the editor holds, as a key other than Enter asks: steering or queued. */
  function submitDraft(how: WhileWorking) {
    submit(editor.getText(), editor.getParts(), editor.getDisplayText(), how)
  }

  /**
   * Runs a "$skill" line. No echo: the message the skill sends shows as typed, with a note of
   * what it loaded; a failure shows on its own.
   */
  function runSkill(line: string, sequence?: number) {
    runHandler("skill.run", line, sequence)
  }

  /**
   * Runs a line an extension's input handler claimed (e.g. "@writer shorter, please" while a
   * swarm runs), at once, even during a turn. It shows as typed; the model never gets it.
   */
  function runInput(line: string, display?: string, sequence?: number) {
    view.commandEcho(display ?? line)
    runHandler("input.run", line, sequence)
  }

  function runHandler(operation: "skill.run" | "input.run", line: string, sequence?: number) {
    const origin = { ...deps.context, ...deps.captureFrontend?.() }
    const context: CommandRunOptions = outbox.commandSend
      ? {
          ...origin,
          onSend: (text, options) => {
            const undo = outbox.commandSend!(text, options, sequence)
            const failed = deps.context.onSend?.(text, options)
            return () => {
              undo()
              failed?.()
            }
          },
        }
      : origin
    const generation = deps.port ? frontendIdentity(deps.port).sessionGeneration : undefined
    const invocationId = crypto.randomUUID()
    let unbind: (() => void) | undefined
    void Promise.resolve()
      .then(async () => {
        if (deps.port) {
          unbind = deps.bindCommandFrontend
            ? deps.bindCommandFrontend(invocationId, context)
            : bindLocalCommandContext(deps.port, invocationId, context)
          await deps.port.execute(
            operation,
            {
              line,
              invocationId,
              ...(context.keys ? { keys: [...context.keys()] } : {}),
              ...(context.glyphs ? { glyphs: context.glyphs() } : {}),
            },
            { signal: context.signal, sessionGeneration: generation },
          )
        } else if (operation === "skill.run") await commands!.runSkill(line, context)
        else await commands!.runInput(line, context)
      })
      .catch((error) => {
        if (
          (context.isFrontendCurrent?.() ?? true) &&
          (!deps.port || frontendIdentity(deps.port).sessionGeneration === generation)
        )
          view.notice("error", error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        unbind?.()
        if (context.isFrontendCurrent?.() ?? true) view.requestRender()
      })
  }

  return { noProviders, noModelYet, submit, submitDraft, runSkill }
}
