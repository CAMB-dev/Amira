import "../server/offline.ts"
import { expect, test } from "bun:test"
import { encodeRemoteMessage, serializeRemoteMessage } from "../../src/remote/codec.ts"
import { RemoteError } from "../../src/remote/errors.ts"
import type { RemoteJson, RemoteMessage } from "../../src/remote/protocol.ts"
import { RemoteWriter } from "../../src/remote/writer.ts"
import {
  validateRemoteDto,
  validateRemoteFrame,
  validateRemoteParams,
  validateRemoteResult,
} from "../../src/remote-schema.ts"
import { hello } from "./loopback.ts"

const toolEvent = (args: Record<string, RemoteJson>) =>
  ({
    v: 1,
    kind: "event",
    daemonEpoch: "epoch-1",
    seq: 1,
    payload: {
      seq: 1,
      ts: 1,
      sessionId: "s1",
      type: "tool.execute.start",
      data: { toolCallId: "call-1", name: "read", args },
    },
  }) satisfies RemoteMessage

async function expectSnapshot(message: RemoteMessage, expected: RemoteMessage) {
  const lines = [...encodeRemoteMessage(message)]
  const writes: Uint8Array[] = []
  const writer = new RemoteWriter(async (bytes) => {
    writes.push(bytes)
  })
  try {
    await writer.send(message)
    expect(JSON.parse(new TextDecoder().decode(Buffer.concat(lines)))).toEqual(expected)
    expect(JSON.parse(new TextDecoder().decode(Buffer.concat(writes)))).toEqual(expected)
  } finally {
    writer.close()
  }
}

test("proxy array toJSON cannot rewrite opaque tool arguments after validation", async () => {
  let hooks = 0
  const array = new Proxy(["original"], {
    get(target, key, receiver) {
      if (key === "toJSON")
        return () => {
          hooks++
          return "replacement"
        }
      return Reflect.get(target, key, receiver)
    },
  })
  await expectSnapshot(toolEvent({ array }), toolEvent({ array: ["original"] }))
  expect(hooks).toBe(0)
})

test("serialization and writer scheduling never use proxy get traps", async () => {
  let gets = 0
  const message = new Proxy(hello, {
    get() {
      gets++
      throw new Error("Original payload must not be read")
    },
  })
  await expectSnapshot(message, hello)
  expect(gets).toBe(0)
})

test("proxy get values cannot differ from the validated descriptor snapshot", async () => {
  const array = new Proxy(["original"], {
    get(target, key, receiver) {
      return key === "0" ? "replacement" : Reflect.get(target, key, receiver)
    },
  })
  await expectSnapshot(toolEvent({ array }), toolEvent({ array: ["original"] }))
})

test("each own descriptor is captured once before nested copying can mutate siblings", () => {
  const reads: string[] = []
  const args = { nested: {}, value: "original" }
  args.nested = new Proxy(
    {},
    {
      ownKeys() {
        args.value = "replacement"
        return []
      },
    },
  )
  const proxied = new Proxy(args, {
    getOwnPropertyDescriptor(target, key) {
      reads.push(String(key))
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  const bytes = serializeRemoteMessage(toolEvent(proxied))
  expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(toolEvent({ nested: {}, value: "original" }))
  expect(reads).toEqual(["nested", "value"])
})

test("public validators validate snapshots without invoking proxy gets", () => {
  const inert = <T extends object>(value: T) =>
    new Proxy(value, {
      get() {
        throw new Error("Original payload must not be read")
      },
    })
  const frame = validateRemoteFrame(inert(hello))
  expect(frame).toEqual(hello)
  expect(frame).not.toBe(hello)
  expect(Object.getPrototypeOf(frame)).toBeNull()
  if (frame.kind !== "hello") throw new Error("Expected hello")
  expect(Object.getPrototypeOf(frame.release)).toBeNull()
  expect(Array.isArray(frame.capabilities)).toBe(true)
  expect(() => validateRemoteParams("command.run", inert({ line: "/status" }))).not.toThrow()
  expect(() => validateRemoteResult("turn.abort", inert({ sessionGeneration: 1 }))).not.toThrow()
  expect(() => validateRemoteDto("coreEvent", inert(toolEvent({}).payload))).not.toThrow()
})

async function rejectsWithoutWriting(message: RemoteMessage) {
  const writes: Uint8Array[] = []
  const writer = new RemoteWriter(async (bytes) => {
    writes.push(bytes)
  })
  let yielded = 0
  let encodingError: unknown
  try {
    for (const _bytes of encodeRemoteMessage(message)) yielded++
  } catch (error) {
    encodingError = error
  }
  const failure = await writer.send(message).catch((error) => error)
  writer.close()
  return { writes, yielded, encodingError, failure }
}

test("proxy accessor descriptors are rejected before yielding or writing bytes without running getters", async () => {
  let getters = 0
  const capabilities = new Proxy(["model.proxy"], {
    getOwnPropertyDescriptor(target, key) {
      if (key === "0")
        return {
          enumerable: true,
          configurable: true,
          get() {
            getters++
            return "replacement"
          },
        }
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
  })
  const result = await rejectsWithoutWriting({ ...hello, capabilities })
  expect(result.encodingError).toBeInstanceOf(RemoteError)
  expect(result.failure).toBeInstanceOf(RemoteError)
  expect(result.yielded).toBe(0)
  expect(result.writes).toHaveLength(0)
  expect(getters).toBe(0)
})

test("array subclasses with inherited toJSON are rejected before yielding or writing bytes", async () => {
  class RewrittenArray extends Array<string> {
    toJSON() {
      return "replacement"
    }
  }
  const result = await rejectsWithoutWriting({ ...hello, capabilities: new RewrittenArray("model.proxy") })
  expect(result.encodingError).toBeInstanceOf(RemoteError)
  expect(result.failure).toBeInstanceOf(RemoteError)
  expect(result.yielded).toBe(0)
  expect(result.writes).toHaveLength(0)
})

for (const [name, prototype] of [
  ["Array", Array.prototype],
  ["Object", Object.prototype],
] as const) {
  test(`inherited toJSON on a plain ${name} prototype cannot change validated data`, async () => {
    const original = Object.getOwnPropertyDescriptor(prototype, "toJSON")
    let hooks = 0
    Object.defineProperty(prototype, "toJSON", {
      configurable: true,
      value() {
        hooks++
        return "replacement"
      },
    })
    let result: Awaited<ReturnType<typeof rejectsWithoutWriting>>
    try {
      result = await rejectsWithoutWriting(hello)
    } finally {
      if (original) Object.defineProperty(prototype, "toJSON", original)
      else Reflect.deleteProperty(prototype, "toJSON")
    }
    expect(result.encodingError).toBeInstanceOf(RemoteError)
    expect(result.failure).toBeInstanceOf(RemoteError)
    expect(result.yielded).toBe(0)
    expect(result.writes).toHaveLength(0)
    expect(hooks).toBe(0)
  })
}
