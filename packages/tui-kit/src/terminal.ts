import { cursor, modes, RESET, type TerminalMode } from "./ansi.ts"

type Listener<T extends unknown[]> = (...args: T) => void

class Emitter<T extends unknown[]> {
  private listeners = new Set<Listener<T>>()
  on(fn: Listener<T>): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  emit(...args: T): void {
    for (const fn of this.listeners) fn(...args)
  }
}

/** The terminal as the UI sees it. Implemented for real stdio and for tests. */
export interface Terminal {
  readonly columns: number
  readonly rows: number
  write(data: string): void
  onInput(fn: (data: string) => void): () => void
  onResize(fn: () => void): () => void
  setRawMode(on: boolean): void
  enableMode(mode: TerminalMode): void
  disableMode(mode: TerminalMode): void
  enterAltScreen(): void
  exitAltScreen(): void
  /** Restores the terminal: leaves every mode that was enabled, shows the cursor, leaves raw mode. */
  restore(): void
}

/** Mode bookkeeping shared by every terminal, so cleanup is the same everywhere. */
export abstract class BaseTerminal implements Terminal {
  abstract readonly columns: number
  abstract readonly rows: number
  abstract write(data: string): void
  protected abstract applyRawMode(on: boolean): void

  protected input = new Emitter<[string]>()
  protected resize = new Emitter<[]>()
  private active: TerminalMode[] = []
  private raw = false

  get isRaw(): boolean {
    return this.raw
  }

  onInput(fn: (data: string) => void): () => void {
    return this.input.on(fn)
  }

  onResize(fn: () => void): () => void {
    return this.resize.on(fn)
  }

  setRawMode(on: boolean): void {
    if (this.raw === on) return
    this.raw = on
    this.applyRawMode(on)
  }

  enableMode(mode: TerminalMode): void {
    if (this.active.includes(mode)) return
    this.active.push(mode)
    this.write(mode.on)
  }

  disableMode(mode: TerminalMode): void {
    const i = this.active.indexOf(mode)
    if (i === -1) return
    this.active.splice(i, 1)
    this.write(mode.off)
  }

  enterAltScreen(): void {
    this.enableMode(modes.altScreen)
  }

  exitAltScreen(): void {
    this.disableMode(modes.altScreen)
  }

  restore(): void {
    const offs = this.active.reverse().map((m) => m.off)
    this.active = []
    this.write(offs.join("") + RESET + cursor.show)
    this.setRawMode(false)
  }
}

type Stdin = NodeJS.ReadStream
type Stdout = NodeJS.WriteStream

/** A terminal on real stdin/stdout. Restores itself when the process exits. */
export class ProcessTerminal extends BaseTerminal {
  private cleanup: (() => void)[] = []
  private size: { columns: number; rows: number }

  constructor(
    private stdin: Stdin = process.stdin,
    private stdout: Stdout = process.stdout,
  ) {
    super()
    this.size = this.readSize()
  }

  get columns(): number {
    return this.size.columns
  }

  get rows(): number {
    return this.size.rows
  }

  write(data: string): void {
    this.stdout.write(data)
  }

  /** Starts reading input and watching the size. */
  start(): void {
    if (this.cleanup.length > 0) return
    const onData = (data: string | Buffer) => this.input.emit(data.toString())
    this.stdin.setEncoding("utf8")
    this.stdin.on("data", onData)
    this.stdin.resume()
    const check = () => {
      const next = this.readSize()
      if (next.columns === this.size.columns && next.rows === this.size.rows) return
      this.size = next
      this.resize.emit()
    }
    this.stdout.on("resize", check)
    // Some platforms do not deliver resize events reliably; polling is cheap.
    const poll = setInterval(check, 250)
    poll.unref?.()
    const onExit = () => this.restore()
    process.on("exit", onExit)
    this.cleanup.push(
      () => this.stdin.off("data", onData),
      () => this.stdin.pause(),
      () => this.stdout.off("resize", check),
      () => clearInterval(poll),
      () => process.off("exit", onExit),
    )
  }

  /** Stops reading input and restores the terminal. */
  stop(): void {
    this.restore()
    for (const fn of this.cleanup) fn()
    this.cleanup = []
  }

  protected applyRawMode(on: boolean): void {
    if (this.stdin.isTTY) this.stdin.setRawMode(on)
  }

  private readSize() {
    return { columns: this.stdout.columns || 80, rows: this.stdout.rows || 24 }
  }
}

/** An in-memory terminal for tests: records writes and lets tests feed input and resize. */
export class FakeTerminal extends BaseTerminal {
  writes: string[] = []

  constructor(
    public columns = 80,
    public rows = 24,
  ) {
    super()
  }

  get output(): string {
    return this.writes.join("")
  }

  write(data: string): void {
    this.writes.push(data)
  }

  send(data: string): void {
    this.input.emit(data)
  }

  setSize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.resize.emit()
  }

  clearWrites(): void {
    this.writes = []
  }

  protected applyRawMode(): void {}
}
