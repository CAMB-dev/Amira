import { expect, test } from "bun:test"
import { watchParent } from "./watchdog.ts"

const encode = (value: string) => new TextEncoder().encode(value)

async function* chunks(...values: string[]) {
  for (const value of values) yield encode(value)
}

test("POSIX parent death EOF kills the injected child group and cleans its generation", async () => {
  const calls: string[] = []
  await watchParent(chunks(), async () => {
    calls.push("kill-exact-group")
    calls.push("remove-owned-root")
  })
  expect(calls).toEqual(["kill-exact-group", "remove-owned-root"])
})

test("a live parent pipe keeps Amira alive until EOF without PID polling", async () => {
  let end!: () => void
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      end = () => controller.close()
    },
  })
  let killed = 0
  const watching = watchParent(input, () => {
    killed++
  })
  await Bun.sleep(5)
  expect(killed).toBe(0)
  end()
  await watching
  expect(killed).toBe(1)
})

test("normal shutdown disarms the guardian, including fragmented pipe writes", async () => {
  let killed = 0
  await watchParent(chunks("dis", "arm", "\n"), () => {
    killed++
  })
  expect(killed).toBe(0)
})

test("broken pipes, partial commands and malformed commands fail closed", async () => {
  let killed = 0
  await watchParent(chunks("disarm"), () => {
    killed++
  })
  expect(killed).toBe(1)
  await expect(
    watchParent(chunks("wrong\n"), () => {
      killed++
    }),
  ).rejects.toThrow("Invalid watchdog command")
  expect(killed).toBe(2)
  const broken = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("broken pipe"))
    },
  })
  await expect(
    watchParent(broken, () => {
      killed++
    }),
  ).rejects.toThrow("broken pipe")
  expect(killed).toBe(3)
})
