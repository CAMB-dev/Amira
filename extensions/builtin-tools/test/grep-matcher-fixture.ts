/** Observe real grep workers without including process startup in operation latency assertions. */
export function observeGrepWorkers(prefix = "") {
  const NativeBlob = globalThis.Blob
  const NativeWorker = globalThis.Worker
  const setTimeout = globalThis.setTimeout
  const clearTimeout = globalThis.clearTimeout
  const revokeObjectURL = URL.revokeObjectURL
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const workers: {
    worker: Worker
    url: string
    started?: number
    terminated: boolean
    listeners: Set<string>
  }[] = []
  const revoked = new Set<string>()

  globalThis.setTimeout = new Proxy(setTimeout, {
    apply(target, thisArg, args) {
      const timer = Reflect.apply(target, thisArg, args)
      if (args[1] === 1_000 || args[1] === 30_000) timers.add(timer)
      return timer
    },
  })
  globalThis.clearTimeout = new Proxy(clearTimeout, {
    apply(target, thisArg, args) {
      timers.delete(args[0])
      return Reflect.apply(target, thisArg, args)
    },
  })
  globalThis.Blob = new Proxy(NativeBlob, {
    construct(target, args) {
      if (args[0]?.some((part: unknown) => typeof part === "string" && part.includes("self.onmessage ="))) {
        args[0] = [prefix, ...args[0]]
      }
      return Reflect.construct(target, args)
    },
  })
  globalThis.Worker = new Proxy(NativeWorker, {
    construct(target, args) {
      const worker: Worker = Reflect.construct(target, args)
      const entry = {
        worker,
        url: String(args[0]),
        started: undefined as number | undefined,
        terminated: false,
        listeners: new Set<string>(),
      }
      workers.push(entry)
      const terminate = worker.terminate.bind(worker)
      worker.postMessage = new Proxy(worker.postMessage, {
        apply(target, thisArg, args) {
          if (typeof args[0]?.pattern === "string") {
            entry.started = performance.now()
          }
          return Reflect.apply(target, thisArg, args)
        },
      })
      worker.terminate = () => {
        entry.terminated = true
        return terminate()
      }
      worker.addEventListener = new Proxy(worker.addEventListener, {
        apply(target, thisArg, args) {
          entry.listeners.add(String(args[0]))
          return Reflect.apply(target, thisArg, args)
        },
      })
      worker.removeEventListener = new Proxy(worker.removeEventListener, {
        apply(target, thisArg, args) {
          entry.listeners.delete(String(args[0]))
          return Reflect.apply(target, thisArg, args)
        },
      })
      return worker
    },
  })
  URL.revokeObjectURL = (url) => {
    revoked.add(url)
    revokeObjectURL.call(URL, url)
  }

  return {
    workers,
    revoked,
    timers,
    restore() {
      for (const { worker, url, terminated } of workers) {
        if (!terminated) worker.terminate()
        if (!revoked.has(url)) URL.revokeObjectURL(url)
      }
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      globalThis.Blob = NativeBlob
      globalThis.Worker = NativeWorker
      globalThis.setTimeout = setTimeout
      globalThis.clearTimeout = clearTimeout
      URL.revokeObjectURL = revokeObjectURL
    },
  }
}
