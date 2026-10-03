import type { UiNode, UiState, ViewDefinition, ViewSegment } from "@amira/api"

/** Independent extension-style proof: semantic widgets only, not a production dashboard. */
export interface DashboardData {
  workspace: string
  workers: { key: string; name: string; task: string; progress: number; files: string[] }[]
  messages: string[]
}

export const dashboardData = (): DashboardData => ({
  workspace: "atlas / 工作区",
  workers: [
    {
      key: "api",
      name: "API worker",
      task: "Define the shared event contract",
      progress: 0.75,
      files: ["packages/api/src/events.ts", "packages/api/test/events.test.ts"],
    },
    {
      key: "ui",
      name: "UI worker",
      task: "Build the timeline and review keyboard navigation at narrow widths",
      progress: 0.5,
      files: ["packages/tui/src/timeline.ts"],
    },
    {
      key: "review",
      name: "Reviewer",
      task: "Check boundaries and regression coverage",
      progress: 0.25,
      files: [],
    },
  ],
  messages: ["10:12:31 Plan accepted", "10:12:40 Workers started", "10:13:02 API tests pass ✓"],
})

export const dashboardState: Partial<UiState> = {
  selected: { timeline: "ui" },
  expanded: { timeline: ["build"] },
  activeTabs: { detail: "logs" },
  focused: "message",
  inputValues: { message: "Review the keyboard paths" },
}

const part = (text: string, kind: ViewSegment["kind"] = "text"): ViewSegment => ({ text, kind })

function workerCard(worker: DashboardData["workers"][number]): UiNode {
  return {
    type: "box",
    title: worker.name,
    aside: "TypeScript",
    tone: "accent",
    child: {
      type: "column",
      children: [
        { size: 1, node: { type: "text", lines: [{ kind: "muted", text: worker.task }] } },
        { size: 1, node: { type: "progress", value: worker.progress, width: 18 } },
        {
          node: {
            type: "table",
            columns: [
              { key: "file", label: "Changed files" },
              { key: "status", label: "Status", size: 10, align: "right" },
            ],
            rows: worker.files.map((file) => ({
              key: file,
              cells: { file, status: [part("modified", "success")] },
            })),
          },
        },
      ],
    },
  }
}

export const dashboard: ViewDefinition<DashboardData> = {
  kind: "widget-dashboard-proof",
  title: () => "Workflow dashboard",
  keys: [{ key: "i", label: "" }],
  ui(data, ctx) {
    const narrow = ctx.width < 110
    const selected = data.workers.find((w) => w.key === ctx.state.selected.timeline) ?? data.workers[0]!
    const timeline: UiNode = {
      type: "tree",
      id: "timeline",
      items: [
        { key: "request", row: [part("10:12:30  ✓ Request", "success")], rail: true },
        {
          key: "plan",
          row: [part("10:12:31  ✓ Plan", "success")],
          aside: [part("done", "muted")],
          rail: true,
        },
        {
          key: "build",
          row: [part("10:12:40  ● Build", "accent")],
          rail: true,
          children: data.workers.map((w) => ({
            key: w.key,
            row: [part(w.name)],
            aside: [part(`${Math.round(w.progress * 100)}%`, "accent")],
            rail: true,
          })),
        },
        { key: "verify", row: [part("○ Verify", "muted")], rail: true, expandable: true },
        { key: "complete", row: [part("○ Complete", "muted")] },
      ],
    }
    const cards: UiNode = {
      type: "column",
      gap: narrow ? 0 : 1,
      children: (narrow ? [selected] : data.workers).map((w) => ({ node: workerCard(w), min: 3 })),
    }
    return {
      type: "column",
      children: [
        {
          size: 1,
          node: {
            type: "bar",
            left: [part("amira  ", "accent"), part(data.workspace), part("  ● Build · 3 workers", "muted")],
            right: [part("$0.042 · 42s", "muted")],
          },
        },
        { size: 1, node: { type: "rule" } },
        {
          node: {
            type: narrow ? "column" : "row",
            gap: 1,
            divider: !narrow,
            children: [
              { node: timeline, size: narrow ? "fill" : "38%", min: 3 },
              { node: { type: "box", title: `Workers · ${selected.name}`, child: cards }, min: 5 },
            ],
          },
        },
        {
          size: narrow ? 6 : 12,
          node: {
            type: "box",
            title: `Details · ${selected.name}`,
            child: {
              type: "tabs",
              id: "detail",
              tabs: [
                {
                  key: "summary",
                  label: "Summary",
                  body: { type: "text", id: "summary", lines: [{ kind: "text", text: selected.task }] },
                },
                {
                  key: "diff",
                  label: "Diff",
                  body: {
                    type: "text",
                    id: "diff",
                    lines: [{ kind: "code", text: "+ export type WorkerEvent = …" }],
                  },
                },
                {
                  key: "logs",
                  label: "Logs",
                  body: {
                    type: "text",
                    id: "logs",
                    follow: true,
                    lines: data.messages.map((text) => ({ kind: "muted", text })),
                  },
                },
                {
                  key: "actions",
                  label: "Actions",
                  body: {
                    type: "text",
                    lines: [{ kind: "text", text: "Enter opens a worker · Type a message below" }],
                  },
                },
              ],
            },
          },
        },
        {
          size: 3,
          node: {
            type: "box",
            title: "Message the team",
            tone: "focus",
            child: { type: "input", id: "message", placeholder: "Ask for a review…", hint: "Enter send" },
          },
        },
      ],
    }
  },
  onEvent(event, data, view) {
    if (event.type === "key" && event.key === "i") view.setState(dashboardState)
    if (event.type === "submit") {
      data.messages.push(event.value)
      view.setState({ inputValues: { message: "" } })
    }
    if (event.type === "activate") view.focus("detail")
  },
}
