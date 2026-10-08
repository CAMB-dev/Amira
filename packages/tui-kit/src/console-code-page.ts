import { dlopen, FFIType } from "bun:ffi"

const UTF8 = 65001

type ConsoleFunctions = {
  GetConsoleOutputCP(): number
  SetConsoleOutputCP(value: number): number
  GetConsoleCP(): number
  SetConsoleCP(value: number): number
}

type Change = { kind: "output" | "input"; codePage: number }

export interface ConsoleCodePage {
  /** Checks at the write boundary, never on a timer. */
  ensure(): void
  /** Relinquishes changes Amira made; Bun owns restoration of its startup output code page. */
  restore(): void
  /** Replays the first drift to a late subscriber (the session trace may start after the UI). */
  onChange(fn: (change: Change) => void): () => void
}

function loadConsoleFunctions(): ConsoleFunctions {
  // DWORD is u32 and BOOL is a 32-bit int, as in @amira/proc's kernel32 bindings.
  return dlopen("kernel32.dll", {
    GetConsoleOutputCP: { args: [], returns: FFIType.u32 },
    SetConsoleOutputCP: { args: [FFIType.u32], returns: FFIType.i32 },
    GetConsoleCP: { args: [], returns: FFIType.u32 },
    SetConsoleCP: { args: [FFIType.u32], returns: FFIType.i32 },
  }).symbols
}

/** Injectable Win32 seam: tests never need to load FFI or change the real console. */
export function createConsoleCodePage(opts: {
  platform: string
  stdoutIsTTY: boolean
  stdinIsTTY: boolean
  load?: () => ConsoleFunctions
}): ConsoleCodePage {
  let functions: ConsoleFunctions | null | undefined
  let active = true
  let change: Change | undefined
  const listeners = new Set<(change: Change) => void>()
  // Bun sets output to UTF-8 before JS starts; input may still have the user's code page.
  const output = { original: 0, changed: false, utf8: true }
  const input = { original: 0, changed: false, utf8: false }
  const get = () => {
    if (opts.platform !== "win32" || !opts.stdoutIsTTY) return null
    if (functions === undefined) {
      try {
        functions = (opts.load ?? loadConsoleFunctions)()
      } catch {
        functions = null
      }
    }
    return functions
  }
  const notify = (fn: (change: Change) => void) => {
    try {
      if (change) fn(change)
    } catch {}
  }
  const report = (kind: Change["kind"], state: typeof output, value: number) => {
    if (!value || value === UTF8 || !active || !state.utf8 || change) return
    change = { kind, codePage: value }
    for (const fn of listeners) notify(fn)
  }
  const ensure = (
    kind: Change["kind"],
    state: typeof output,
    read: () => number,
    set: (value: number) => number,
  ) => {
    const value = read()
    if (!value) return // No attached console (or an unavailable handle).
    if (!state.original) state.original = value
    if (value === UTF8) {
      state.utf8 = true
      return
    }
    report(kind, state, value)
    if (set(UTF8)) {
      state.changed = true
      state.utf8 = true
    }
  }
  const restore = (state: typeof output, set: (value: number) => number) => {
    // Bun has already switched output to UTF-8 before JS runs. Its pre-startup value is
    // private to Bun: do not guess it from the input CP, or overwrite Bun's exit restore.
    if (state.changed && state.original !== UTF8 && set(state.original)) state.changed = false
  }
  return {
    ensure() {
      const k = get()
      if (!k) return
      try {
        ensure("output", output, k.GetConsoleOutputCP, k.SetConsoleOutputCP)
        if (opts.stdinIsTTY) ensure("input", input, k.GetConsoleCP, k.SetConsoleCP)
        active = true
      } catch {
        // FFI is best-effort, including failures after the DLL loaded.
      }
    },
    restore() {
      const k = functions
      if (!k) return
      // The process exit listener runs before terminal/trace cleanup. Observe final drift
      // before relinquishing ownership, without reasserting UTF-8 or fighting Bun's restore.
      if (active) {
        try {
          report("output", output, k.GetConsoleOutputCP())
        } catch {}
        try {
          if (opts.stdinIsTTY) report("input", input, k.GetConsoleCP())
        } catch {}
      }
      active = false
      try {
        restore(output, k.SetConsoleOutputCP)
      } catch {}
      try {
        if (opts.stdinIsTTY) restore(input, k.SetConsoleCP)
      } catch {}
    },
    onChange(fn) {
      listeners.add(fn)
      notify(fn)
      return () => listeners.delete(fn)
    },
  }
}

/** Shared by terminal writes and the CLI's stdout batches, so drift is logged once per process. */
export const consoleCodePage = createConsoleCodePage({
  platform: process.platform,
  stdoutIsTTY: !!process.stdout.isTTY,
  stdinIsTTY: !!process.stdin.isTTY,
})
process.on("exit", () => consoleCodePage.restore())
