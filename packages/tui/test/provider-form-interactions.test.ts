import { expect, test } from "bun:test"
import { type ProviderAdmin, providerFormSpec } from "@amira/api"
import { key, type MouseInput, stripAnsi, textKey } from "@amira/tui-kit"
import { plain } from "../../tui-kit/test/context.ts"
import { FormView, specFormBackend } from "../src/form-view.ts"

const click = (view: FormView, x: number, y: number) => {
  const mouse = (action: MouseInput["action"]): MouseInput => ({
    type: "mouse",
    action,
    button: "left",
    x,
    y,
    shift: false,
    alt: false,
    ctrl: false,
  })
  view.handleInput(mouse("press"))
  view.handleInput(mouse("release"))
}

function setup() {
  const requests: string[] = []
  const admin: ProviderAdmin = {
    dialects: () => ["openai-chat", "anthropic-messages"],
    exists: () => false,
    draft: () => undefined,
    storedKeyHint: () => undefined,
    envIsSet: () => false,
    cachedVendors: () => [
      {
        id: "demo",
        name: "Demo",
        dialect: "openai-chat",
        baseUrl: "https://demo.example/v1",
        env: ["DEMO_KEY"],
        models: ["catalog-only"],
      },
    ],
    describeModels: (_draft, ids) => ids.map((id) => ({ id, inCatalog: false })),
    listModels: async (draft) => {
      requests.push(draft.baseUrl)
      return [
        { id: "demo-one", inCatalog: false },
        { id: "demo-two", inCatalog: false },
      ]
    },
    test: async () => ({ ok: true, latencyMs: 1, message: "OK" }),
    save: async () => "Saved",
    remove: async () => "Removed",
    setKey: async () => "Stored",
  }
  const spec = providerFormSpec(admin)
  const view = new FormView(
    specFormBackend(spec, () => {}),
    { requestRender: () => {}, onClose: () => {} },
  )
  const screen = () => view.render(120, { ...plain, rows: 36 }).map(stripAnsi)
  const focus = (id: string) => {
    for (let i = 0; i < 100 && view.form.focused !== "vendor"; i++)
      view.handleInput(key("tab", { shift: true }))
    for (let i = 0; i < 100 && view.form.focused !== id; i++) view.handleInput(key("tab"))
    expect(view.form.focused).toBe(id)
  }
  const type = (text: string) => {
    for (const ch of text) view.handleInput(textKey(ch))
  }
  const hit = (text: string) => {
    const lines = screen()
    const y = lines.findIndex((line) => line.includes(text))
    expect(y).toBeGreaterThanOrEqual(0)
    return { x: lines[y]!.indexOf(text), y }
  }
  return { view, screen, focus, type, hit, requests }
}

test("catalog details keep editing through live renders; Custom always exposes endpoint fields", () => {
  const form = setup()
  try {
    expect(form.screen().join("\n")).toContain("Base URL *")
    form.view.handleInput(key("enter"))
    form.type("Demo")
    form.view.handleInput(key("enter"))
    form.focus("\u0000summary:endpoint:demo")
    form.view.handleInput(key("enter"))
    form.view.handleInput(key("tab"))
    expect(form.view.form.focused).toBe("id")
    form.type("-other")
    expect(form.screen().join("\n")).toContain("Base URL *")
    expect(form.view.form.focused).toBe("id")
    form.focus("vendor")
    form.view.handleInput(key("enter"))
    form.type("Custom")
    form.view.handleInput(key("enter"))
    const screen = form.screen().join("\n")
    expect(screen).toContain("Base URL *")
    expect(screen).not.toContain("[ Edit ]")
  } finally {
    form.view.close()
  }
})

// Exercises the card through the real provider spec and FormView, not just action readiness.
test("a catalog pick fills endpoint details and fetches models once after key confirmation", async () => {
  const form = setup()
  try {
    form.view.handleInput(key("enter"))
    form.type("Demo")
    form.view.handleInput(key("enter"))
    expect(form.view.form.values).toMatchObject({
      vendor: "demo",
      id: "demo",
      dialect: "openai-chat",
      baseUrl: "https://demo.example/v1",
      models: [],
    })
    expect(form.screen().join("\n")).toContain("openai-chat · https://demo.example/v1 [ Edit ]")
    expect(form.screen().join("\n")).not.toContain("Base URL *")
    const edit = form.hit("[ Edit ]")
    click(form.view, edit.x + 2, edit.y)
    expect(form.screen().join("\n")).toContain("Base URL *")
    form.view.handleInput(key("enter")) // Collapse the same summary without taking a field's value away.
    expect(form.screen().join("\n")).not.toContain("Base URL *")
    form.focus("apiKey")
    form.type("mock-key")
    await Bun.sleep(0)
    expect(form.requests).toEqual([])
    form.view.handleInput(key("tab"))
    const deadline = performance.now() + 3000
    while (!form.screen().join("\n").includes("models listed")) {
      if (performance.now() > deadline) throw new Error("automatic fetch did not reach the card")
      await Bun.sleep(5)
    }
    expect(form.requests).toEqual(["https://demo.example/v1"])
    expect(form.view.form.values.models).toEqual([])
    form.focus("models")
    const all = form.hit("[ All ]")
    click(form.view, all.x + 2, all.y)
    expect(form.view.form.values.models).toEqual(["demo-one", "demo-two"])
    const none = form.hit("[ None ]")
    click(form.view, none.x + 2, none.y)
    expect(form.view.form.values.models).toEqual([])
    form.focus("models")
    form.type("one")
    form.view.handleInput(key("a", { ctrl: true }))
    expect(form.view.form.values.models).toEqual(["demo-one"])
  } finally {
    form.view.close()
  }
})
