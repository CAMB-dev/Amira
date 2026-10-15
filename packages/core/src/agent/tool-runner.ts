// Owns tool-batch scheduling, execution and abort settlement.
import { invalidArgs, type ToolCallBlock, type ToolResultMessage } from "@amira/ai"
import type {
  BackgroundJobSession,
  MutateFiles,
  ToolApproval,
  ToolDefinition,
  ToolRejection,
  ToolResult,
  ToolSession,
} from "@amira/api"
import type { FileRewind } from "../file-rewind.ts"
import type { InterceptorRegistry } from "../interceptors.ts"
import type { Permissions } from "../permissions/policy.ts"
import { withWrittenPathsCheck, writtenPaths } from "../permissions/protected.ts"
import type { WritePathCheck, WriteRootPolicy } from "../permissions/write-roots.ts"
import {
  beforeShellCall,
  captureShellTool,
  classifyShell,
  shellEntryChanged,
  shellGuardNames,
} from "../shell-tool.ts"
import type { ToolRegistry } from "../tool-registry.ts"
import { toolTraits } from "../tool-traits.ts"
import { checkArgs } from "../validate-args.ts"
import { type ApprovalGate, approvalWaitMs } from "./approvals.ts"
import type { CallRun } from "./call-run.ts"
import { concurrencyKey, copyArgs, normalizeResult, resultMessage, toolError } from "./messages.ts"
import { askedText, refusedText } from "./permission-text.ts"
import type { Emit, Turn } from "./types.ts"

/** Only the session capabilities a batch of tool calls needs. */
interface ToolRunnerDeps {
  tools: ToolRegistry
  interceptors: InterceptorRegistry
  permissions: Pick<Permissions, "check">
  approvals: ApprovalGate
  cwd: string
  sessionId: string
  maxParallelTools: number
  abortGraceMs: number
  fileRewind: FileRewind | undefined
  backgroundJobs: BackgroundJobSession | undefined
  /** Re-read per call: the model and its allowed tools can change between batches. */
  allowsTool: (tool: ToolDefinition) => boolean
  /** Execution policy, independent of the model-visible declarations. */
  callableTools?: ReadonlySet<string>
  writePolicy?: WriteRootPolicy
  isSubAgent?: boolean
  /** Read when building each call's context; Agent replaces the controller after a steer. */
  steerSignal: () => AbortSignal | undefined
  /** Read at write time. */
  storeFailed: () => boolean
  callSession: (turn: Turn, toolCallId: string) => ToolSession
  expectNotice?: ToolSession["expectNotice"]
  keepLarge: (call: ToolCallBlock, result: ToolResult) => Promise<ToolResult>
  /** Dismissal stops the turn; the caller must check that it is still the current turn. */
  interruptTurn: (turn: Turn) => void
  emit: Emit
}

interface ToolRunOptions {
  /** Bound invocations preserve execution failures independently of presentation interceptors. */
  preserveErrors?: boolean
  /** Durable final-argument evidence, immediately before actual executor dispatch. */
  beforeExecute?: (call: ToolCallBlock, args: Record<string, unknown>) => void
}

/** Runs one session's tool batches; history and turn ownership stay with the caller. */
export class ToolRunner {
  #deps: ToolRunnerDeps
  /** The definition that executed a call, kept when a tool is later disabled or replaced. */
  #callTools = new WeakMap<ToolCallBlock, ToolDefinition>()
  /** Physical calls, including output persistence, outlive abort-grace result settlement. */
  #pending = new Set<Promise<unknown>>()

  constructor(deps: ToolRunnerDeps) {
    this.#deps = deps
  }

  toolFor(call: ToolCallBlock): ToolDefinition | undefined {
    return this.#callTools.get(call) ?? this.#deps.tools.get(call.name)
  }

  /**
   * Starts calls in order, concurrently up to maxParallelTools (D71). Serial tools wait for
   * earlier calls and run alone; equal concurrency keys run sequentially. Every call gets
   * exactly one result, even if a tool throws, misbehaves or ignores abort.
   * Settles synchronously in finally, in call order, after synthesizing aborted results and
   * marking every run finished, before any error propagates.
   */
  async run(
    turn: Turn,
    calls: ToolCallBlock[],
    settle: (results: ToolResultMessage[], outputs: ToolResult[]) => void,
    options: ToolRunOptions = {},
  ): Promise<void> {
    const runs: CallRun[] = calls.map((call) => ({ call, started: false, finished: false }))
    try {
      const running = new Set<Promise<void>>()
      const started: Promise<void>[] = []
      const lastByKey = new Map<string, Promise<void>>()
      for (const run of runs) {
        const call = run.call
        if (turn.signal.aborted) break
        const tool = this.#deps.tools.get(call.name)
        run.tool = tool
        if (tool) this.#callTools.set(call, tool)
        const serial = tool !== undefined && (tool.concurrency ?? "serial") === "serial"
        if (serial) await this.#untilDoneOrAbandoned(turn.signal, Promise.all(started))
        while (running.size >= this.#deps.maxParallelTools && !turn.signal.aborted) {
          await this.#untilDoneOrAbandoned(turn.signal, Promise.race(running))
        }
        if (turn.signal.aborted) break

        const task: Promise<void> = (async () => {
          const r = await this.#runTool(
            turn,
            run,
            runs,
            async (authorizedTool, args) => {
              if (serial || turn.signal.aborted || run.finished) return
              // Reserve only authorized calls, using the arguments their gates approved.
              // Async gates may clear out of order; do not stall unrelated keys behind them.
              const key = concurrencyKey(authorizedTool, { ...call, args }, this.#deps.cwd)
              if (key === undefined) return
              const before = lastByKey.get(key)
              lastByKey.set(key, task)
              if (before) await this.#untilDoneOrAbandoned(turn.signal, before)
            },
            options,
          )
          if (!run.finished) run.result = r
        })().finally(() => running.delete(task))
        this.#track(task)
        running.add(task)
        started.push(task)
        if (serial) await this.#untilDoneOrAbandoned(turn.signal, task)
      }
      await this.#untilDoneOrAbandoned(turn.signal, Promise.all(started))
    } finally {
      for (const run of runs) {
        if (!run.result) {
          run.result = toolError(run.call, "Aborted by the user before this tool finished.", "aborted")
          this.#emitToolStart(turn, run, run.call.args)
          this.#emitToolEnd(turn, run, { content: run.result.content, isError: true }, 0, "aborted")
        }
        run.finished = true
      }
      const results = runs.map((run) => run.result!)
      settle(
        results,
        runs.map((run) => run.output ?? { content: run.result!.content, isError: true }),
      )
    }
  }

  /** Ownership includes journal cleanup and output persistence after an executor returns. */
  async drain(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending])
  }

  #track<T>(work: Promise<T>): Promise<T> {
    this.#pending.add(work)
    const clear = () => this.#pending.delete(work)
    void work.then(clear, clear)
    return work
  }

  #execute<T>(work: () => Promise<T>): Promise<T> {
    return this.#track(Promise.resolve().then(work))
  }

  /** Waits for the batch, but after an abort gives tools only abortGraceMs to stop. */
  async #untilDoneOrAbandoned(signal: AbortSignal, work: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const abandoned = new Promise<void>((resolve) => {
      onAbort = () => {
        timer = setTimeout(resolve, this.#deps.abortGraceMs)
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      await Promise.race([work, abandoned])
    } finally {
      clearTimeout(timer)
      if (onAbort) signal.removeEventListener("abort", onAbort)
    }
  }

  /** Never rejects: every failure becomes an error result for the model. */
  async #runTool(
    turn: Turn,
    run: CallRun,
    batch: readonly CallRun[],
    waitForKey: (tool: ToolDefinition, args: Record<string, unknown>) => Promise<void>,
    options: ToolRunOptions,
  ): Promise<ToolResultMessage> {
    const call = run.call
    // Every outcome goes through tool.call.after (skipped once the turn is interrupted), then
    // tool.execute.end.
    const finish = async (
      args: Record<string, unknown>,
      first: ToolResult,
      durationMs: number,
      rejected?: ToolRejection,
    ): Promise<ToolResultMessage> => {
      const failed = !!first.isError
      run.returned = true
      if (rejected) this.#emitToolStart(turn, run, args)
      const result = await this.#deps.keepLarge(
        call,
        await this.#afterTool(turn, run, batch, args, first, rejected),
      )
      // Model calls retain interceptor recovery; direct owned checks cannot report false success.
      if (run.ceilingDenied || (options.preserveErrors && (rejected || failed || turn.signal.aborted)))
        result.isError = true
      if (!run.finished) {
        run.output = result
        this.#emitToolEnd(turn, run, result, durationMs, rejected, run.approval)
      }
      return resultMessage(call, result, rejected)
    }
    const reject = (rejected: ToolRejection, text: string, args = call.args) =>
      finish(args, { content: [{ type: "text", text }], isError: true }, 0, rejected)
    const ceilingCheck = <T>(check: () => T): T => {
      try {
        return check()
      } catch (error) {
        run.ceilingDenied = true
        throw error
      }
    }
    try {
      const bad = invalidArgs(call.args)
      if (bad !== undefined) {
        return await reject(
          "invalidArgs",
          `Invalid JSON in tool arguments. Retry with valid JSON. Received: ${bad.slice(0, 500)}`,
        )
      }
      // Capture the definition and its registration owner together before awaited interceptors.
      const registration = this.#deps.tools.getRegistration(call.name)
      const tool = registration?.tool
      run.tool = tool
      // A tool hidden from this model is not available even if it calls the name anyway.
      if (!tool || !this.#deps.allowsTool(tool)) {
        const names = this.#deps.tools
          .active()
          .filter((t) => this.#deps.allowsTool(t))
          .map((t) => t.name)
          .join(", ")
        return await reject("unknownTool", `Unknown tool "${call.name}". Available tools: ${names}`)
      }
      if (
        (this.#deps.isSubAgent && tool.mainOnly) ||
        (this.#deps.callableTools && !this.#deps.callableTools.has(call.name))
      ) {
        run.ceilingDenied = true
        return await reject("blocked", `Tool "${call.name}" is not callable in this session.`)
      }
      // Classification precedes interceptors and approvals; neither may change the dialect
      // whose name-scoped guards and command rules authorize this call.
      const shellTool = captureShellTool(tool)
      const shellTraits = shellTool.traits
      const shell = await classifyShell(shellTool)
      const shellKind = shell?.kind
      const guardNames = shellGuardNames(shellTool, shell, shellTraits?.shell)
      const disabledShell = () => guardNames.find((name) => this.#deps.tools.disabled.has(name))
      if (disabledShell())
        return await reject("blocked", `Shell tool "${disabledShell()}" is disabled by host policy.`)
      const gate = await beforeShellCall(
        this.#deps.interceptors,
        guardNames,
        { toolCallId: call.id, name: call.name, args: call.args },
        { sessionId: this.#deps.sessionId, signal: turn.signal },
      )
      if (gate.blocked) {
        return turn.signal.aborted
          ? await reject("aborted", "Aborted by the user before this tool ran.")
          : await reject("blocked", `Tool call blocked: ${gate.reason}`)
      }
      const args = copyArgs(gate.value.args)
      // Every report must clear the ceiling before any approval, including interceptor asks.
      const writeChecks: WritePathCheck[] = []
      let firstPaths: readonly string[] | undefined
      const { policy, paths } = await withWrittenPathsCheck(
        args,
        (reported) => {
          const ceiling = this.#deps.writePolicy
          if (!ceiling || (!toolTraits(tool)?.writesFiles && !tool.getWrittenPaths && reported === undefined))
            return
          ceilingCheck(() => {
            writeChecks.push(ceiling.check(this.#deps.cwd, reported))
            // A later report cannot change the paths on which protected-file permissions decided.
            if (
              firstPaths &&
              (reported!.length !== firstPaths.length || reported!.some((p, i) => p !== firstPaths![i]))
            )
              throw new Error("File write ceiling: write-path report changed during authorization")
            firstPaths ??= Object.freeze([...reported!])
            Object.freeze(reported)
          })
        },
        async () => {
          await this.#deps.writePolicy?.tool(tool, args, this.#deps.cwd)
          const permissionTool = shell
            ? {
                get name() {
                  return tool.name
                },
                get traits() {
                  return shellTraits
                },
                getWrittenPaths: tool.getWrittenPaths?.bind(tool),
                shellKind: () => {
                  // Preserve policy's static/both-shell fallback without retrying resolution.
                  if (shellKind === undefined) throw new Error("Shell kind unavailable")
                  return shellKind
                },
              }
            : tool
          // Permissions still decides on the tool's final arguments and registration owner.
          const policy = await this.#deps.permissions.check(
            permissionTool,
            args,
            this.#deps.cwd,
            registration?.dataOwner,
          )
          // Bookkeeping must not introduce an unchecked report after approval.
          const paths = await writtenPaths(tool, args, this.#deps.cwd)
          return { policy, paths }
        },
      )
      const recheckWrites = () =>
        ceilingCheck(() => {
          for (const check of writeChecks) check()
        })
      if (turn.signal.aborted)
        return await reject("aborted", "Aborted by the user before this tool ran.", args)
      if (policy.decision === "deny") return await reject("blocked", refusedText(policy), args)
      const asking = policy.decision === "ask"
      if (asking || gate.ask) {
        run.approvalTiming = {}
        const verdict = await this.#deps.approvals.approve(
          turn,
          { id: call.id, name: call.name, args: copyArgs(args) },
          policy,
          gate.ask,
          run.approvalTiming,
        )
        // Dismissing the question stops the turn, like an interrupt.
        if (!verdict.approved && verdict.interrupt) this.#deps.interruptTurn(turn)
        if (verdict.approved && verdict.by) run.approval = verdict.by
        if (turn.signal.aborted)
          return await reject("aborted", "Aborted by the user before this tool ran.", args)
        if (!verdict.approved) {
          const why = `Tool call not approved${verdict.reason ? `: ${verdict.reason}` : "."}`
          return await reject("blocked", asking ? `${why}\n${askedText(policy)}` : why, args)
        }
      }
      const problem = checkArgs(tool.parameters, args)
      if (problem) return await reject("invalidArgs", `Invalid arguments for ${call.name}: ${problem}`, args)
      await waitForKey(tool, args)
      if (turn.signal.aborted || run.finished)
        return await reject("aborted", "Aborted by the user before this tool ran.", args)
      if (paths !== undefined) run.writtenPaths = paths

      // Listeners get a copy: the arguments the policy checked are the ones the tool runs with.
      this.#emitToolStart(turn, run, copyArgs(args))
      // Let frontends draw "running <tool>" first: a tool may block the event loop for a while
      // (spawning a process can stall for seconds on some Windows machines).
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      if (turn.signal.aborted || run.finished)
        return await reject("aborted", "Aborted by the user before this tool ran.", args)
      if (shellEntryChanged(tool, shellTool))
        return await reject("blocked", "The shell changed after authorization; retry the command.", args)
      if (
        !this.#deps.tools.isEnabled(tool) ||
        !this.#deps.tools.isEnabled(tool, shellTool) ||
        disabledShell()
      )
        return await reject("blocked", `Tool "${call.name}" is disabled by host policy.`, args)
      recheckWrites?.()
      const started = performance.now()
      let result: ToolResult
      let executionClosed = false
      const assertActive = () => {
        if (turn.signal.aborted || run.finished || executionClosed)
          throw new Error("Tool execution was aborted or its mutation capability was revoked")
      }
      try {
        // Installed even without a rewind journal. Recheck after journal awaits, immediately
        // before mutation; a report is not authority to mutate an additional destination.
        const guardMutation =
          (mutation?: MutateFiles): MutateFiles =>
          async (changes, write) => {
            assertActive()
            recheckWrites()
            const recheckChanges = ceilingCheck(() =>
              this.#deps.writePolicy?.check(
                this.#deps.cwd,
                changes.map((c) => c.path),
              ),
            )
            const guardedWrite = async () => {
              assertActive()
              recheckWrites()
              ceilingCheck(() => recheckChanges?.())
              const commits = ceilingCheck(() =>
                writeChecks.map((check) => check.mutation(changes.map((change) => change.path))),
              )
              await write()
              ceilingCheck(() => {
                for (const commit of commits) commit()
              })
            }
            return mutation ? mutation(changes, guardedWrite) : guardedWrite()
          }
        const journal: MutateFiles | undefined = this.#deps.fileRewind
          ? async (changes, write) => {
              if (this.#deps.storeFailed() && this.#deps.fileRewind!.enabled)
                throw new Error("File write refused: the session could not be saved")
              return this.#deps.fileRewind!.mutate(changes, write, {
                sessionId: this.#deps.sessionId,
                toolCallId: call.id,
                turnId: turn.id,
              })
            }
          : undefined
        const mutateFiles = this.#deps.writePolicy || journal ? guardMutation(journal) : undefined
        const steerSignal = this.#deps.steerSignal()
        const context = {
          cwd: this.#deps.cwd,
          ...(shellKind ? { shellKind } : {}),
          toolCallId: call.id,
          signal: turn.signal,
          ...(steerSignal ? { steerSignal } : {}),
          ...(this.#deps.backgroundJobs ? { backgroundJobs: this.#deps.backgroundJobs } : {}),
          session: this.#deps.callSession(turn, call.id),
          ...(this.#deps.expectNotice ? { expectNotice: this.#deps.expectNotice } : {}),
          ...(mutateFiles ? { mutateFiles } : {}),
          update: (partial: ToolResult) => {
            if (run.finished) return
            this.#deps.emit(turn, "tool.execute.update", { toolCallId: call.id, name: call.name, partial })
          },
        }
        const traits = toolTraits(tool)
        const pathCapture =
          this.#deps.fileRewind?.enabled &&
          paths !== undefined &&
          paths.length > 0 &&
          (traits?.writesFiles === true || traits?.writesFiles === "paths") &&
          traits.usesMutationHook !== true
        const execute = (mutateFilesOverride?: MutateFiles) => {
          assertActive()
          recheckWrites()
          options.beforeExecute?.(call, copyArgs(args))
          assertActive()
          return tool.execute(args, {
            ...context,
            ...(mutateFilesOverride ? { mutateFiles: mutateFilesOverride } : {}),
          })
        }
        result = await this.#execute(async () => {
          try {
            assertActive()
            if (pathCapture) {
              // Like the mutateFiles hook: no captured write once the session cannot be saved.
              if (this.#deps.storeFailed())
                throw new Error("File write refused: the session could not be saved")
              let captured: ToolResult | undefined
              await this.#deps.fileRewind!.mutatePaths(
                paths!,
                this.#deps.cwd,
                async (mutateFiles) => {
                  recheckWrites()
                  captured = await execute(guardMutation(mutateFiles))
                },
                {
                  sessionId: this.#deps.sessionId,
                  toolCallId: call.id,
                  turnId: turn.id,
                },
              )
              return normalizeResult(captured!)
            }
            return normalizeResult(await execute(mutateFiles))
          } finally {
            executionClosed = true
          }
        })
      } catch (err) {
        const msg = turn.signal.aborted
          ? "Aborted by the user."
          : `Tool failed: ${err instanceof Error ? err.message : String(err)}`
        result = { content: [{ type: "text", text: msg }], isError: true }
      }
      return await finish(args, result, Math.round(performance.now() - started))
    } catch (err) {
      const text = `Tool call failed before running: ${err instanceof Error ? err.message : String(err)}`
      // Like the other rejections, through tool.call.after (a handler waiting for the last
      // call of the batch must see this one), unless finishing is what failed.
      if (!run.returned) {
        try {
          return await reject("blocked", text)
        } catch {}
      }
      run.returned = true
      this.#emitToolStart(turn, run, call.args)
      if (!run.finished) {
        this.#emitToolEnd(turn, run, { content: [{ type: "text", text }], isError: true }, 0, "blocked")
      }
      return toolError(call, text, "blocked")
    }
  }

  /**
   * Runs tool.call.after on a call's result. An interrupt skips it: the result stands as it
   * is, like after a failing handler.
   */
  async #afterTool(
    turn: Turn,
    run: CallRun,
    batch: readonly CallRun[],
    args: Record<string, unknown>,
    result: ToolResult,
    rejected?: ToolRejection,
  ): Promise<ToolResult> {
    if (turn.signal.aborted || run.finished) return result
    const pending = batch
      .filter((r) => r !== run && !r.returned && !r.finished)
      .map((r) => ({ toolCallId: r.call.id, name: r.call.name }))
    const out = await this.#deps.interceptors.run(
      "tool.call.after",
      {
        toolCallId: run.call.id,
        name: run.call.name,
        args,
        cwd: this.#deps.cwd,
        ...(rejected ? { rejected } : {}),
        pending,
        result,
      },
      { sessionId: this.#deps.sessionId, signal: turn.signal },
    )
    // The registry already dropped modifications without content (see InterceptorRegistry.run).
    const next = out.value.result
    return next === result ? result : normalizeResult(next)
  }

  #emitToolStart(turn: Turn, run: CallRun, args: Record<string, unknown>) {
    if (run.started) return
    run.started = true
    const traits = run.tool && toolTraits(run.tool)
    this.#deps.emit(turn, "tool.execute.start", {
      toolCallId: run.call.id,
      name: run.call.name,
      args,
      ...(traits ? { traits } : {}),
      ...(run.writtenPaths !== undefined ? { writtenPaths: run.writtenPaths } : {}),
    })
  }

  #emitToolEnd(
    turn: Turn,
    run: CallRun,
    result: ToolResult,
    durationMs: number,
    rejected?: ToolRejection,
    approval?: ToolApproval,
  ) {
    const traits = run.tool && toolTraits(run.tool)
    const waitedMs = approvalWaitMs(run.approvalTiming)
    this.#deps.emit(turn, "tool.execute.end", {
      toolCallId: run.call.id,
      name: run.call.name,
      result,
      durationMs,
      ...(waitedMs !== undefined ? { waitedMs } : {}),
      ...(traits ? { traits } : {}),
      ...(run.writtenPaths !== undefined ? { writtenPaths: run.writtenPaths } : {}),
      ...(rejected ? { rejected } : {}),
      ...(approval ? { approval } : {}),
    })
  }
}
