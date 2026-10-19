import { FileIndex, type FileSource } from "../file-index.ts"

/** Main keeps the host's file source; owned conversations index their own working directory. */
export function conversationFiles(
  main: FileSource | undefined,
  cwd: () => string,
  focused: () => boolean,
  create: (cwd: string) => FileSource = (cwd) => new FileIndex(cwd),
) {
  const indexes = new Map<string, FileSource>()
  const listeners = new Set<() => void>()
  const offs: (() => void)[] = []
  const changed = () => {
    for (const listener of listeners) listener()
  }
  if (main) offs.push(main.subscribe(changed))
  const source = () => {
    if (!focused() && main) return main
    const path = cwd()
    let index = indexes.get(path)
    if (!index) {
      index = create(path)
      indexes.set(path, index)
      offs.push(index.subscribe(changed))
    }
    return index
  }
  return {
    listing: () => source().listing(),
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose() {
      for (const off of offs) off()
      for (const index of indexes.values()) index.dispose?.()
      listeners.clear()
    },
  } satisfies FileSource
}
