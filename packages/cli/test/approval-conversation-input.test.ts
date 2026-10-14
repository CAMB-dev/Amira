import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { MockStep } from "@amira/ai"
import {
  type ApprovalRequest,
  type CommandContext,
  defineTool,
  type OwnedConversation,
  textResult,
} from "@amira/api"
import { OwnedConversationManager } from "@amira/core"
import { closeImageApp, setup, waitFor } from "../../tui/test/app-harness.ts"
import { userApprover } from "../src/session/approvals.ts"

async function approvalSetup(
  mode: "inline" | "fullscreen",
  mainWorking: boolean,
  gate: "permission" | "interceptor" = "permission",
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "amira-approval-input-"))
  let conversation!: OwnedConversation
  let context: CommandContext | undefined
  const steps: MockStep[] = [
    ...(mainWorking ? [{ toolCalls: [{ name: "hold", args: {} }] }] : []),
    { toolCalls: [{ id: "owned-call", name: "bash", args: { command: "build-project" } }] },
  ]
  const s = await setup(steps, {
    cwd: directory,
    cols: 100,
    rows: 30,
    tree: true,
    settings: { mode },
    commands: [
      {
        name: "design",
        description: "Focus design",
        run: (_args, ctx) => {
          context = ctx
          ctx.focusConversation?.(conversation)
        },
      },
    ],
  })
  const requests: ApprovalRequest[] = []
  const approve = userApprover(s.host.ui, { tree: s.agent.tree })
  s.agent.permissions.setMode(gate === "permission" ? "edits" : "auto")
  if (gate === "interceptor") {
    s.agent.interceptors.add("tool.call.before", (call) =>
      call.name === "bash" ? { action: "ask", reason: "Build approval" } : { action: "pass" },
    )
  }
  s.agent.permissions.approver = (request, signal) => {
    requests.push(request)
    return approve(request, signal)
  }
  let executed = 0
  s.agent.tools.register(
    defineTool({
      name: "bash",
      description: "Build the project",
      parameters: {},
      traits: { shell: "bash" },
      execute: async () => {
        executed++
        return textResult("built")
      },
    }),
    "test",
  )
  let holding = false
  s.agent.tools.register(
    defineTool({
      name: "hold",
      description: "Keep the main turn working until interrupted",
      parameters: {},
      traits: { readOnly: true },
      execute: async (_args, ctx) => {
        holding = true
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) resolve()
          else ctx.signal.addEventListener("abort", () => resolve(), { once: true })
        })
        return textResult("stopped")
      },
    }),
    "test",
  )
  const manager = new OwnedConversationManager({
    ai: s.ai,
    tools: s.agent.tools,
    tree: s.agent.tree!,
    agent: () => s.agent,
    home: directory,
  })
  conversation = await manager.forOwner("approval-test").openOrCreate(
    {
      key: "design",
      name: "Design approval",
      cwd: directory,
      systemPrompt: "",
      callableTools: ["bash", "hold"],
    },
    { askUser: async () => undefined },
  )
  let mainAborts = 0
  const abort = s.agent.abort.bind(s.agent)
  s.agent.abort = () => {
    mainAborts++
    abort()
  }
  const close = async () => {
    abort()
    s.host.ui.cancelAll()
    context?.unfocusConversation?.()
    await manager.drain()
    await closeImageApp(s)
    rmSync(directory, { recursive: true, force: true })
  }
  return {
    ...s,
    conversation,
    requests,
    mainAborts: () => mainAborts,
    executed: () => executed,
    holding: () => holding,
    close,
  }
}

for (const mode of ["inline", "fullscreen"] as const) {
  for (const mainWorking of [false, true]) {
    for (const gate of ["permission", "interceptor"] as const) {
      for (const key of ["\x1b", "\x03"]) {
        test(`${mode}: real owned ${gate} cancellation leaves main alone, main working=${mainWorking}, key=${JSON.stringify(key)}`, async () => {
          const s = await approvalSetup(mode, mainWorking, gate)
          try {
            if (mainWorking) {
              s.terminal.send("Working main\r")
              await waitFor(s.holding, "main tool working")
            }
            s.terminal.send("/design\r")
            await waitFor(() => s.live().includes("Design approval"), "owned focus")
            s.terminal.send("Build owned\r")
            await waitFor(() => s.host.ui.pending.length === 1, "owned approval request")
            expect(s.requests).toHaveLength(1)
            expect(s.requests[0]?.sessionId).toBe(s.conversation.id)
            if (gate === "permission") expect(s.requests[0]?.permission?.mode).toBe("edits")
            else expect(s.requests[0]?.permission).toBeUndefined()
            expect(s.host.ui.pending[0]).toMatchObject({
              sessionId: s.conversation.id,
              source: "approval",
              kind: "confirm",
              title: "Allow bash?",
            })
            await waitFor(() => s.live().includes("Allow bash?"), "owned approval visible")
            s.terminal.send(key)
            await waitFor(() => !s.conversation.status().busy, "owned stopped")
            await s.bus.flush()
            expect(s.mainAborts()).toBe(0)
            expect(s.agent.status).toBe(mainWorking ? "working" : "idle")
            expect(s.conversation.status()).toEqual({ state: "stopped", busy: false })
            expect(s.host.ui.pending).toEqual([])
            expect(s.executed()).toBe(0)
          } finally {
            await s.close()
          }
        })
      }
    }
  }

  for (const key of ["\x1b", "\x03"]) {
    test(`${mode}: a background owned approval does not attach to the active main transcript, key=${JSON.stringify(key)}`, async () => {
      const s = await approvalSetup(mode, true)
      let ownedTurn: Promise<void> | undefined
      try {
        s.terminal.send("Working main\r")
        await waitFor(s.holding, "main tool working")
        ownedTurn = s.conversation.send("Build owned")
        await waitFor(() => s.host.ui.pending.length === 1, "background owned request")
        await s.bus.flush()
        expect(s.requests[0]?.sessionId).toBe(s.conversation.id)
        expect(s.host.ui.pending[0]?.sessionId).toBe(s.conversation.id)
        expect(s.live()).not.toContain("Allow bash?")
        expect(s.agent.status).toBe("working")
        s.terminal.send("/design\r")
        await waitFor(() => s.live().includes("Allow bash?"), "owned request after focus")
        s.terminal.send(key)
        await ownedTurn
        await s.bus.flush()
        expect(s.mainAborts()).toBe(0)
        expect(s.agent.status).toBe("working")
        expect(s.conversation.status()).toEqual({ state: "stopped", busy: false })
        expect(s.executed()).toBe(0)
      } finally {
        await s.close()
        await ownedTurn
      }
    })

    test(`${mode}: a real main approval still interrupts main, not the working owned conversation, key=${JSON.stringify(key)}`, async () => {
      const s = await approvalSetup(mode, true)
      let ownedTurn: Promise<void> | undefined
      try {
        ownedTurn = s.conversation.send("Working owned")
        await waitFor(s.holding, "owned tool working")
        s.terminal.send("Build main\r")
        await waitFor(() => s.host.ui.pending.length === 1, "main approval request")
        expect(s.requests[0]?.sessionId).toBe(s.agent.sessionId)
        expect(s.host.ui.pending[0]).toMatchObject({
          sessionId: s.agent.sessionId,
          source: "approval",
          title: "Allow bash?",
        })
        await waitFor(() => s.live().includes("Allow bash?"), "main approval visible")
        s.terminal.send(key)
        await s.idle()
        expect(s.mainAborts()).toBe(1)
        expect(s.conversation.status().busy).toBe(true)
        expect(s.host.ui.pending).toEqual([])
        expect(s.executed()).toBe(0)
      } finally {
        await s.close()
        await ownedTurn
      }
    })
  }
}
