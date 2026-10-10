/** Capture synchronous frames with one clock style, independent of the host's locale preference. */
export function withSnapshotClock<Args extends unknown[], Result>(
  capture: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args) => {
    const prototype = Intl.DateTimeFormat.prototype
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "format")!
    const format = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format
    Object.defineProperty(prototype, "format", { ...descriptor, get: () => format })
    try {
      return capture(...args)
    } finally {
      Object.defineProperty(prototype, "format", descriptor)
    }
  }
}
