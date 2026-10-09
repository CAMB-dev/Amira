import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { userMessage } from "@amira/ai"
import {
  bashTool,
  powershellDescription,
  powershellTool,
} from "../../../extensions/builtin-tools/src/bash.ts"
import { availableShellTools, shellToolNames } from "../../../extensions/builtin-tools/src/shell.ts"
import { anthropicAi, anthropicResponse, textReply } from "../../ai/test/anthropic-helpers.ts"
import { fakeFetch, type Seen } from "../../ai/test/helpers.ts"
import { createCommandHost } from "../src/control.ts"
import { createSession } from "../src/session.ts"

const PREFIX_BUDGET = { total: 15_000, perTool: 1800 }

async function captureSession(
  run: (session: Awaited<ReturnType<typeof createSession>>, seen: Seen) => Promise<void>,
  extra: Partial<Parameters<typeof createSession>[0]> = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "amira-prefix-"))
  const skillDir = join(cwd, "skills", "example")
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: example\ndescription: Example task instructions\n---\nUse the tools.\n",
  )
  const seen: Seen = {}
  const ai = anthropicAi(fakeFetch(() => anthropicResponse(textReply("ok")), seen))
  const session = await createSession({
    cwd,
    extensions: [],
    noBuiltins: false,
    autoTitle: false,
    ai,
    model: "anth/claude",
    settings: { skills: { dirs: [join(cwd, "skills")] } },
    ...extra,
  })
  try {
    expect(session.startupEvents.filter((e) => e.type === "extension.error")).toEqual([])
    await run(session, seen)
  } finally {
    await session.agent.dispose("exit")
    await session.host.unloadAll()
    rmSync(cwd, { recursive: true, force: true })
  }
}

test("default Anthropic request stays within the tool prefix budget", async () => {
  await captureSession(async (session, seen) => {
    createCommandHost({ session, cwd: session.agent.cwd })
    await session.agent.prompt(userMessage("Say ok."))
    const tools = seen.body.tools as { name: string }[]
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "agent",
        "agent_result",
        "ask_user",
        "edit",
        "glob",
        "grep",
        "job_list",
        "job_output",
        "job_stop",
        "output_read",
        "read",
        "skill",
        "web_fetch",
        "web_search",
        "write",
        ...(await shellToolNames()),
      ].sort(),
    )
    expect(JSON.stringify(tools).length).toBeLessThanOrEqual(PREFIX_BUDGET.total)
    for (const tool of tools) {
      expect(JSON.stringify(tool).length, tool.name).toBeLessThanOrEqual(PREFIX_BUDGET.perTool)
    }
    // Windows PowerShell 5.1 needs extra syntax/error rules; budget that edition too.
    const legacy = tools.map((tool) =>
      tool.name === "powershell"
        ? { ...tool, description: powershellDescription("powershell.exe").join("\n") }
        : tool,
    )
    expect(JSON.stringify(legacy).length).toBeLessThanOrEqual(PREFIX_BUDGET.total)
    for (const tool of legacy) {
      expect(JSON.stringify(tool).length, tool.name).toBeLessThanOrEqual(PREFIX_BUDGET.perTool)
    }
  })
})

test("initial shell choice reaches fallback tools before a command host is attached", async () => {
  for (const mode of ["auto", "bash", "powershell"] as const) {
    await captureSession(
      async (session, seen) => {
        await session.agent.prompt("Say ok.")
        expect(seen.body.tools.map((t: { name: string }) => t.name)).toEqual([
          mode === "bash" ? "bash" : "powershell",
        ])
      },
      {
        shell: mode,
        settings: { shell: "auto" },
        builtins: async () => [
          {
            source: "test:shells",
            extension: async (api) => {
              const tools = await availableShellTools(
                [bashTool, powershellTool],
                () => api.session()?.info().shell ?? api.settings.shell,
                "win32",
                async () => ({ kind: "powershell" }),
              )
              for (const tool of tools) api.registerTool(tool)
            },
          },
        ],
      },
    )
  }
})

test("explicit shell modes send only that tool and auto restores available shells", async () => {
  await captureSession(async (session, seen) => {
    const commands = createCommandHost({ session, cwd: session.agent.cwd })
    const modes = process.platform === "win32" ? (["bash", "powershell"] as const) : (["bash"] as const)
    for (const mode of modes) {
      commands.control.setShell(mode)
      await session.agent.prompt("Say ok.")
      expect(
        seen.body.tools
          .map((t: { name: string }) => t.name)
          .filter((n: string) => ["bash", "powershell"].includes(n)),
      ).toEqual([mode])
    }
    commands.control.setShell("auto")
    await session.agent.prompt("Say ok.")
    expect(
      seen.body.tools
        .map((t: { name: string }) => t.name)
        .filter((n: string) => ["bash", "powershell"].includes(n)),
    ).toEqual(await shellToolNames())
  })
})
