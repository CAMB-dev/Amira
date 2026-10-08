import { describe, expect, test } from "bun:test"
import {
  autoFormActions,
  checkForm,
  type FormDialogs,
  type FormSpec,
  type FormValues,
  formDefaults,
  isFieldVisible,
  runFormAction,
  runFormDialogs,
  toFormSchema,
} from "../src/form.ts"

const spec = (): FormSpec => ({
  title: "Server",
  sections: [{ title: "Limits", optional: true }],
  fields: [
    {
      type: "text",
      id: "name",
      label: "Name",
      required: true,
      pattern: "[a-z]+",
      patternMessage: "lower case only",
    },
    {
      type: "select",
      id: "auth",
      label: "Auth",
      options: [{ value: "key", label: "Stored key" }, { value: "env" }],
    },
    { type: "secret", id: "key", label: "Key", when: { field: "auth", is: "key" } },
    { type: "text", id: "env", label: "Variable", when: { field: "auth", is: "env" }, required: true },
    {
      type: "action",
      id: "fetch",
      label: "Fetch",
      recommended: true,
      auto: { watch: ["auth", "key", "env"], ready: (values) => values.auth === "env" || !!values.key },
      run: async ({ values, progress }) => {
        progress("asking")
        return {
          message: `got 2 for ${values.name}`,
          options: { tags: [{ value: "a" }, { value: "b" }] },
          values: { key: "leak", note: "filled" },
        }
      },
    },
    { type: "multiselect", id: "tags", label: "Tags", options: [], allowCustom: true },
    { type: "number", id: "max", label: "Max", section: "Limits", integer: true, min: 1 },
    { type: "checkbox", id: "fast", label: "Fast", section: "Limits" },
    {
      type: "textarea",
      id: "note",
      label: "Note",
      validate: (v) => (v.includes("bad") ? "no bad words" : undefined),
    },
  ],
  validate: (v) => (v.name === "root" ? { name: "is reserved" } : undefined),
})

describe("schema and values", () => {
  test("toFormSchema drops validators and action callbacks, copying only automatic watches", () => {
    const form = spec()
    const action = form.fields.find((f) => f.id === "fetch")!
    if (action.type !== "action" || !action.auto) throw new Error("Missing automatic action")
    Object.assign(action, { validate: () => "not serializable" })
    const schema = toFormSchema(form)
    const json = JSON.parse(JSON.stringify(schema))
    expect(json).toEqual(schema)
    expect(schema.fields.find((f) => f.id === "fetch")).toEqual({
      type: "action",
      id: "fetch",
      label: "Fetch",
      recommended: true,
      auto: { watch: ["auth", "key", "env"] },
    })
    expect("validate" in schema.fields.find((f) => f.id === "note")!).toBe(false)
    const serialized = schema.fields.find((f) => f.id === "fetch")!
    if (serialized.type !== "action" || !serialized.auto) throw new Error("Missing automatic metadata")
    expect(serialized.auto.watch).not.toBe(action.auto.watch)
    serialized.auto.watch.push("name")
    expect(action.auto.watch).toEqual(["auth", "key", "env"])
  })

  test("automatic readiness sees sanitized partial values without running actions or validators", () => {
    let effects = 0
    const received: FormValues[] = []
    const form: FormSpec = {
      title: "t",
      fields: [
        {
          type: "text",
          id: "name",
          label: "Name",
          required: true,
          validate: () => {
            effects++
            return undefined
          },
        },
        { type: "checkbox", id: "enabled", label: "Enabled", default: true },
        { type: "secret", id: "hidden", label: "Hidden", when: { field: "enabled", is: false } },
        {
          type: "action",
          id: "ready",
          label: "Ready",
          auto: {
            watch: ["enabled"],
            ready: (values) => {
              received.push(values)
              return values.enabled === true
            },
          },
          run: async () => {
            effects++
            return undefined
          },
        },
        {
          type: "action",
          id: "hiddenAction",
          label: "Hidden action",
          when: { field: "enabled", is: false },
          auto: {
            watch: ["enabled"],
            ready: () => {
              effects++
              return true
            },
          },
          run: async () => {
            effects++
            return undefined
          },
        },
        {
          type: "action",
          id: "notReady",
          label: "Not ready",
          auto: { watch: [], ready: () => false },
          run: async () => {
            effects++
            return undefined
          },
        },
        {
          type: "action",
          id: "manual",
          label: "Manual",
          run: async () => {
            effects++
            return undefined
          },
        },
      ],
      validate: () => {
        effects++
        return undefined
      },
    }
    expect(autoFormActions(form, { hidden: "secret", extra: "unknown" })).toEqual(["ready"])
    expect(received).toEqual([{ name: "", enabled: true }])
    expect(autoFormActions(form, { enabled: true })).toEqual(["ready"])
    expect(effects).toBe(0)
  })

  test("defaults: first option, empty secret, no number", () => {
    expect(formDefaults(spec())).toEqual({
      name: "",
      auth: "key",
      key: "",
      env: "",
      tags: [],
      fast: false,
      note: "",
    })
  })

  test("visibility follows `when`, through fields that are hidden themselves", () => {
    const s: FormSpec = {
      title: "t",
      fields: [
        { type: "checkbox", id: "a", label: "a" },
        {
          type: "select",
          id: "b",
          label: "b",
          options: [{ value: "x" }, { value: "y" }],
          when: { field: "a", is: true },
        },
        { type: "text", id: "c", label: "c", when: { field: "b", is: ["x"] } },
      ],
    }
    const c = s.fields[2]!
    expect(isFieldVisible(s, c, { a: false, b: "x" })).toBe(false)
    expect(isFieldVisible(s, c, { a: true, b: "x" })).toBe(true)
    expect(isFieldVisible(s, c, { a: true, b: "y" })).toBe(false)
  })

  test("checkForm normalizes, drops hidden fields and reports problems", () => {
    const r = checkForm(spec(), { name: "Bad", auth: "env", key: "secret", max: "1.5", extra: 1 })
    expect(r.errors).toEqual({ name: "lower case only", env: "is required", max: "must be a whole number" })
    expect(r.values.key).toBeUndefined()
    expect("extra" in r.values).toBe(false)

    const ok = checkForm(spec(), { name: "abc", key: "k", max: "12", tags: ["x", "x", " y "] })
    expect(ok.errors).toEqual({})
    expect(ok.values).toMatchObject({ name: "abc", auth: "key", key: "k", max: 12, tags: ["x", "y"] })
    expect(checkForm(spec(), { name: "abc", auth: "nope" }).errors.auth).toContain("one of the options")
    expect(checkForm(spec(), { name: "abc", note: "bad" }).errors.note).toBe("no bad words")
    // The form-level check runs once the fields pass.
    expect(checkForm(spec(), { name: "root" }).errors).toEqual({ name: "is reserved" })
  })

  test("multiselect options may come from an action", () => {
    const s: FormSpec = { title: "t", fields: [{ type: "multiselect", id: "m", label: "m", options: [] }] }
    expect(checkForm(s, { m: ["a"] }).errors.m).toContain("not an option")
    expect(checkForm(s, { m: ["a"] }, { m: [{ value: "a" }] }).errors).toEqual({})
  })

  test("action results cannot set secret fields", async () => {
    const r = await runFormAction(
      spec(),
      "fetch",
      { name: "abc" },
      { signal: new AbortController().signal, progress: () => {} },
    )
    expect(r.message).toBe("got 2 for abc")
    expect(r.values).toEqual({ note: "filled" })
    expect(r.options).toEqual({ tags: [{ value: "a" }, { value: "b" }] })
    const failing: FormSpec = {
      title: "t",
      fields: [{ type: "action", id: "x", label: "x", run: async () => Promise.reject(new Error("boom")) }],
    }
    expect(
      await runFormAction(failing, "x", {}, { signal: new AbortController().signal, progress: () => {} }),
    ).toEqual({
      message: "boom",
      tone: "error",
    })
  })
})

/** Dialogs answered from a script; records what was asked. */
function scripted(answers: (string | undefined)[]) {
  const asked: string[] = []
  const ui: FormDialogs = {
    select: async (title, options) => {
      asked.push(`${title} [${options.join("|")}]`)
      return answers.shift()
    },
    input: async (title, opts) => {
      asked.push(`${title}${opts?.secret ? " (secret)" : ""}${opts?.initial ? ` =${opts.initial}` : ""}`)
      return answers.shift()
    },
  }
  return { ui, asked }
}

describe("runFormDialogs", () => {
  test("automatic metadata never starts actions in one-question-at-a-time dialogs", async () => {
    let runs = 0
    const form: FormSpec = {
      title: "t",
      fields: [
        {
          type: "action",
          id: "fetch",
          label: "Fetch",
          recommended: true,
          auto: { watch: [], ready: () => true },
          run: async () => {
            runs++
            return undefined
          },
        },
      ],
    }
    const { ui, asked } = scripted(["No", "Save"])
    expect(await runFormDialogs(form, ui)).toEqual({})
    expect(asked).toEqual(["Fetch? [Yes|No]", "t: Save? [Save|Cancel]"])
    expect(runs).toBe(0)
  })

  test("asks each shown field, runs a chosen action and ends with Save", async () => {
    const { ui, asked } = scripted([
      "Abc", // bad pattern, asked again
      "abc",
      "Stored key",
      "sk-1",
      "Yes", // fetch
      "[ ] a",
      "Add values…",
      "z, w",
      "Done",
      "Yes", // Limits section
      "0", // below min, asked again
      "7",
      "Yes",
      "hello",
      "Save",
    ])
    const values = await runFormDialogs(spec(), ui)
    expect(values).toEqual({
      name: "abc",
      auth: "key",
      key: "sk-1",
      tags: ["a", "z", "w"],
      max: 7,
      fast: true,
      note: "hello",
    })
    expect(asked[0]).toBe("Server · Name")
    expect(asked[1]).toBe("✗ lower case only\nServer · Name")
    expect(asked[3]).toBe("Server · Key (secret)")
    expect(asked[4]).toBe("Fetch? [Yes|No]")
    // The action's message comes with the next question.
    expect(asked[5]).toStartWith("got 2 for abc\nServer · Tags [Done|Add values…|[ ] a|[ ] b]")
    expect(asked[11]).toContain("must be at least 1")
    expect(asked.at(-1)).toBe("Server: Save? [Save|Cancel]")
  })

  test("an optional section can be skipped, and a cancelled dialog cancels the form", async () => {
    const { ui } = scripted(["abc", "env", "MY_KEY", "No", "Done", "No", "", "Save"])
    expect(await runFormDialogs(spec(), ui)).toEqual({
      name: "abc",
      auth: "env",
      env: "MY_KEY",
      tags: [],
      fast: false,
      note: "",
    })
    const cancelled = scripted(["abc", undefined])
    expect(await runFormDialogs(spec(), cancelled.ui)).toBeUndefined()
  })
})

test("patterns ignore the spaces a pasted line brings", () => {
  const s: FormSpec = { title: "t", fields: [{ type: "text", id: "v", label: "v", pattern: "[A-Z_]+" }] }
  expect(checkForm(s, { v: "DEEPSEEK_API_KEY " }).errors).toEqual({})
})
