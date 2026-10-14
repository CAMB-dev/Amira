import {
  defineExtension,
  type ToolResult,
  textResult,
  type ViewDefinition,
} from "../../packages/api/src/index.ts"

interface Fixture {
  name: string
  args: Record<string, unknown>
  result: ToolResult
}

const realTools = new Set(["ask_user", "agent", "agent_result", "tool_search", "workflow", "swarm"])

/** Copied into the isolated home and loaded with the ordinary --extension flag. */
export default defineExtension((api) => {
  const configured = api.settings.extensions?.["ui-walk"]?.results
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
    throw new Error("UI walk fixture results are missing")
  }
  const fixtures = configured as Record<string, Fixture>
  const focusView: ViewDefinition = {
    kind: "focus-view",
    title: () => "Focus walkthrough",
    follow: false,
    ui: (_data, ctx) => ({
      type: "column",
      children: [
        { size: 1, node: { type: "bar", left: [{ kind: "accent", text: "Focus walkthrough" }] } },
        {
          node: {
            type: "tree",
            id: "tasks",
            items: ["Dashboard", "Swarm", "Workflow"].map((text) => ({
              key: text,
              row: [{ kind: "text", text }],
            })),
          },
        },
        {
          size: 1,
          node: {
            type: "bar",
            left: [{ kind: "muted", text: ctx.focused === false ? "View inactive" : "View active" }],
          },
        },
      ],
    }),
  }
  api.registerView(focusView)
  api.registerView({ ...focusView, kind: "focus-tab-view", needsTab: true })
  api.registerCommand({
    name: "focus-view",
    description: "Open the offline focus walkthrough",
    run: (args, ctx) => void ctx.openView?.({ kind: args === "tabs" ? "focus-tab-view" : "focus-view" }),
  })
  // Keep the built-in presenters, but replace execution for exactly the fixture's names.
  // Scripted arguments are matched by the interceptors; the inert tool needs no real I/O.
  for (const name of new Set(Object.values(fixtures).map((fixture) => fixture.name))) {
    if (realTools.has(name)) throw new Error(`UI walk must not override the real ${name} tool`)
    api.registerTool({
      name,
      description: "UI walk fixture: displays canned results without executing the original tool.",
      parameters: { type: "object" },
      override: true,
      concurrency: "parallel",
      traits: { readOnly: true, usesMutationHook: true },
      execute: async () => textResult("UI walk fixture result pending"),
    })
  }
  const children = new Set<string>()
  api.on("session.start", (event) => {
    if (event.parentSessionId !== undefined) children.add(event.sessionId)
  })
  api.intercept("context.build", (value, ctx) => ({
    action: "modify",
    value: {
      ...value,
      systemPrompt: `${value.systemPrompt}\n[ui-walk-fixtures]${children.has(ctx.sessionId) ? `\n[ui-walk-child:${ctx.sessionId}]` : ""}`,
    },
  }))
  // Unknown calls fail closed before permissions/execution. Known calls run only the inert
  // override; after supplies their result. This avoids rendering canned success as blocked.
  api.intercept(
    "tool.call.before",
    (call) => {
      if (call.name === "agent") {
        const tasks = call.args.tasks
        if (
          !Array.isArray(tasks) ||
          tasks.some(
            (task) =>
              !task ||
              typeof task !== "object" ||
              task.isolation !== "none" ||
              (task.model !== undefined && !String(task.model).startsWith("ui-walk/")),
          )
        ) {
          return { action: "block", reason: "UI walk agents require isolation:none and a scripted model" }
        }
      }
      if (realTools.has(call.name)) return { action: "pass" }
      const fixture = fixtures[call.toolCallId]
      if (fixture?.name === call.name && sameArgs(fixture.args, call.args)) return { action: "pass" }
      return { action: "block", reason: "UI walk fixture: tool execution is disabled" }
    },
    { priority: -10_000 },
  )
  api.intercept("tool.call.after", (call) => {
    if (realTools.has(call.name) || call.rejected !== undefined) return { action: "pass" }
    const fixture = fixtures[call.toolCallId]
    if (!fixture || fixture.name !== call.name || !sameArgs(fixture.args, call.args)) {
      return { action: "pass" }
    }
    return { action: "modify", value: { ...call, result: structuredClone(fixture.result) } }
  })
})

/** Key order does not matter; array order and the actual values do. */
function sameArgs(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameArgs(value, right[index]))
    )
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => Object.hasOwn(b, key) && sameArgs(a[key], b[key]))
  )
}
