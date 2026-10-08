import { expect, mock, test } from "bun:test"
import { createConsoleCodePage } from "../src/console-code-page.ts"

function setup(
  output = 65001,
  input = 65001,
  opts: Partial<Parameters<typeof createConsoleCodePage>[0]> = {},
) {
  const values = { output, input }
  const functions = {
    GetConsoleOutputCP: mock(() => values.output),
    SetConsoleOutputCP: mock((value: number) => {
      values.output = value
      return 1
    }),
    GetConsoleCP: mock(() => values.input),
    SetConsoleCP: mock((value: number) => {
      values.input = value
      return 1
    }),
  }
  const load = mock(() => functions)
  const owner = createConsoleCodePage({
    platform: "win32",
    stdoutIsTTY: true,
    stdinIsTTY: true,
    load,
    ...opts,
  })
  const log = mock<Parameters<typeof owner.onChange>[0]>(() => {})
  owner.onChange(log)
  return { owner, values, functions, load, log }
}

test("UTF-8 batches only query once per console channel and load FFI once", () => {
  const { owner, functions: k, load, log } = setup()
  owner.ensure()
  owner.ensure()
  expect(load).toHaveBeenCalledTimes(1)
  expect(k.GetConsoleOutputCP).toHaveBeenCalledTimes(2)
  expect(k.GetConsoleCP).toHaveBeenCalledTimes(2)
  expect(k.SetConsoleOutputCP).not.toHaveBeenCalled()
  expect(k.SetConsoleCP).not.toHaveBeenCalled()
  expect(log).not.toHaveBeenCalled()
})

test("reports output drift that occurred before the first Amira write", () => {
  const { owner, values, log } = setup(936, 936)
  owner.ensure()
  expect(values).toEqual({ output: 65001, input: 65001 })
  expect(log.mock.calls).toEqual([[{ kind: "output", codePage: 936 }]])
})

test("reasserts after every output drift but reports the first value only", () => {
  const { owner, values, functions: k, log } = setup()
  owner.ensure()
  values.output = 936
  owner.ensure()
  expect(values.output).toBe(65001)
  values.output = 437
  owner.ensure()
  expect(values.output).toBe(65001)
  expect(k.SetConsoleOutputCP.mock.calls).toEqual([[65001], [65001]])
  expect(log.mock.calls).toEqual([[{ kind: "output", codePage: 936 }]])
})

test("owns input too, without diagnosing its initial non-UTF-8 value as drift", () => {
  const { owner, values, functions: k, log } = setup(65001, 936)
  owner.ensure()
  expect(values.input).toBe(65001)
  expect(log).not.toHaveBeenCalled()
  values.input = 950
  owner.ensure()
  values.output = 437
  owner.ensure()
  expect(k.SetConsoleCP.mock.calls).toEqual([[65001], [65001]])
  expect(log.mock.calls).toEqual([[{ kind: "input", codePage: 950 }]])
})

for (const opts of [{ platform: "linux" }, { platform: "darwin" }, { stdoutIsTTY: false }]) {
  test(`no FFI for ${JSON.stringify(opts)}, even with console stdin`, () => {
    const { owner, functions: k, load, log } = setup(936, 936, opts)
    owner.ensure()
    owner.restore()
    expect(load).not.toHaveBeenCalled()
    expect(k.GetConsoleOutputCP).not.toHaveBeenCalled()
    expect(k.GetConsoleCP).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })
}

test("redirected stdin is untouched", () => {
  const { owner, values, functions: k } = setup(936, 936, { stdinIsTTY: false })
  owner.ensure()
  expect(values.output).toBe(65001)
  expect(values.input).toBe(936)
  owner.restore()
  expect(k.GetConsoleCP).not.toHaveBeenCalled()
  expect(k.SetConsoleCP).not.toHaveBeenCalled()
})

test("FFI load failure is cached and never escapes", () => {
  const load = mock(() => {
    throw new Error("FFI unavailable")
  })
  const { owner, log } = setup(936, 936, { load })
  expect(() => {
    owner.ensure()
    owner.ensure()
    owner.restore()
  }).not.toThrow()
  expect(load).toHaveBeenCalledTimes(1)
  expect(log).not.toHaveBeenCalled()
})

test("FFI call failures and failed setters never crash writes", () => {
  const { owner, functions: k } = setup(936, 936)
  k.GetConsoleOutputCP.mockImplementationOnce(() => {
    throw new Error("console unavailable")
  })
  expect(() => owner.ensure()).not.toThrow()
  k.SetConsoleOutputCP.mockReturnValueOnce(0)
  owner.ensure()
  owner.ensure()
  expect(k.SetConsoleOutputCP.mock.calls).toEqual([[65001], [65001]])
  k.SetConsoleCP.mockImplementationOnce(() => {
    throw new Error("console lost")
  })
  expect(() => owner.restore()).not.toThrow()
})

test("zero code pages mean no console, not a value to set or restore", () => {
  const { owner, functions: k, log } = setup(0, 0)
  owner.ensure()
  owner.restore()
  expect(k.SetConsoleOutputCP).not.toHaveBeenCalled()
  expect(k.SetConsoleCP).not.toHaveBeenCalled()
  expect(log).not.toHaveBeenCalled()
})

test("restores only Amira's changes, keeping distinct input and output baselines", () => {
  const { owner, values, functions: k, log } = setup(936, 950)
  owner.ensure()
  owner.restore()
  owner.restore()
  expect(values).toEqual({ output: 936, input: 950 })
  expect(k.SetConsoleOutputCP.mock.calls).toEqual([[65001], [936]])
  expect(k.SetConsoleCP.mock.calls).toEqual([[65001], [950]])
  // Taking back the terminal must not diagnose our intentional restore as external drift.
  owner.ensure()
  expect(values).toEqual({ output: 65001, input: 65001 })
  expect(log.mock.calls).toEqual([[{ kind: "output", codePage: 936 }]])
})

test("does not overwrite Bun's output restore with its startup 65001", () => {
  const { owner, values, functions: k } = setup(65001, 936)
  owner.ensure()
  values.output = 936
  owner.ensure()
  // Bun's exit cleanup may run before or after ours: neither order leaves UTF-8 behind.
  values.output = 936
  owner.restore()
  expect(values).toEqual({ output: 936, input: 936 })
  expect(k.SetConsoleOutputCP.mock.calls).toEqual([[65001]])
})

test("exit ordering reports final drift before trace flush and emergency output", () => {
  const { owner, values, functions: k, log } = setup()
  const events: string[] = []
  owner.onChange(() => events.push("diagnostic"))
  owner.ensure()
  values.output = 936
  const exitListeners = [
    () => owner.restore(),
    () => events.push("trace flush"),
    () => {
      owner.ensure()
      events.push("emergency write")
      owner.restore()
    },
  ]
  exitListeners[0]!()
  expect(values.output).toBe(936)
  expect(k.SetConsoleOutputCP).not.toHaveBeenCalled()
  for (const listener of exitListeners.slice(1)) listener()
  expect(events).toEqual(["diagnostic", "trace flush", "emergency write"])
  expect(log.mock.calls).toEqual([[{ kind: "output", codePage: 936 }]])
})

test("late trace subscribers receive drift once; unsubscribe and broken loggers are harmless", () => {
  const { owner, values } = setup()
  owner.onChange(() => {
    throw new Error("trace unavailable")
  })
  owner.ensure()
  values.output = 936
  expect(() => owner.ensure()).not.toThrow()
  expect(values.output).toBe(65001)
  const late = mock<Parameters<typeof owner.onChange>[0]>(() => {})
  const off = owner.onChange(late)
  expect(late.mock.calls).toEqual([[{ kind: "output", codePage: 936 }]])
  off()
  values.output = 950
  owner.ensure()
  owner.restore()
  owner.ensure()
  expect(late).toHaveBeenCalledTimes(1)
})

test("restoring an unused owner does not load FFI", () => {
  const { owner, load } = setup()
  owner.restore()
  expect(load).not.toHaveBeenCalled()
})
