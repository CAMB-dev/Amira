import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import * as api from "../src/index.ts"

for (const locale of ["", "zh/", "ja/"]) {
  const file = new URL(`../../../docs/${locale}extensions.md`, import.meta.url)
  test(`${locale || "en/"} status badge docs describe the exported table and padded form`, () => {
    const text = readFileSync(file, "utf8")
    expect(text).toContain("AGENT_STATUS_BADGES")
    for (const key of Object.keys(api.AGENT_STATUS_BADGES.stopped)) expect(text).toContain(key)
    expect(text).toContain("{ pad: true }")
    expect(text).toContain("API_VERSION")
  })

  test(`${locale || "en/"} compatibility example works when named badge exports are absent`, () => {
    const text = readFileSync(file, "utf8")
    const snippet = /```ts\n(import \* as amira[\s\S]*?)\n```/.exec(text)?.[1]
    expect(snippet).toBeDefined()
    if (!snippet) throw new Error("Missing feature-detection example")
    const source = new Bun.Transpiler({ loader: "ts" }).transformSync(
      snippet.replace('import * as amira from "@amira/api"', ""),
    )
    const load = new Function("amira", `${source}\nreturn displayState`)
    const stringOnlyHost = {
      agentStatusState: (state: unknown) =>
        state === "running"
          ? "working"
          : state === "error"
            ? "failed"
            : state === "aborted"
              ? "stopped"
              : state,
    }
    for (const host of [api, stringOnlyHost, {}]) {
      const displayState = load(host)
      for (const state of ["running", "queued", "idle", "paused", "done", "error", "aborted"] as const)
        expect(displayState(state)).toBe(api.agentStatusState(state))
      expect(displayState("done", "")).toBe("stopped")
      expect(displayState("done", "turn limit reached")).toBe("stopped")
      expect(displayState("running", undefined, true)).toBe("paused")
    }
  })
}
