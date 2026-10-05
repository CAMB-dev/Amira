import { expect, spyOn, test } from "bun:test"
import { type BufferEncodingOption, type EncodingOption, type PathLike, realpathSync } from "node:fs"
import os from "node:os"
import { Permissions } from "../src/permissions/policy.ts"

const cwd = "C:\\project"
const home = "C:\\private-home"
const write = { name: "write" }

function realpathMapper(map: (p: string) => string): typeof realpathSync.native {
  function resolve(p: PathLike, options?: EncodingOption): string
  function resolve(p: PathLike, options: BufferEncodingOption): Buffer<ArrayBuffer>
  function resolve(p: PathLike, options?: EncodingOption): string | Buffer<ArrayBuffer>
  function resolve(p: PathLike, options?: EncodingOption | BufferEncodingOption) {
    const name = map(String(p))
    const encoding = typeof options === "string" ? options : options?.encoding
    return encoding === "buffer" ? Buffer.from(name) : name
  }
  return resolve
}

// Windows realpath can retain a UNC name rather than translate it to a drive path.
// Mock the mapper so these regressions do not require an actual writable share.
test("core writes ask through local admin-share aliases of a custom Amira home", async () => {
  const mapper = spyOn(realpathSync, "native").mockImplementation(realpathMapper((p) => p))
  try {
    const policy = new Permissions({ protect: { platform: "win32", amiraHome: home, env: {} } })
    for (const server of [
      "localhost",
      "127.0.0.1",
      "127.0.0.2",
      "--1.ipv6-literal.net",
      ".",
      os.hostname(),
    ]) {
      for (const prefix of [`\\\\${server}\\C$`, `\\\\?\\UNC\\${server}\\C$`]) {
        expect(
          await policy.check(write, { path: `${prefix}\\private-home\\settings.json` }, cwd),
        ).toMatchObject({
          decision: "ask",
          cause: "protected",
        })
      }
    }
    expect((await policy.check(write, { path: "C:\\ordinary\\file.txt" }, cwd)).decision).toBe("allow")
    expect((await policy.check(write, { path: "\\\\localhost\\C$\\ordinary\\file.txt" }, cwd)).decision).toBe(
      "allow",
    )
  } finally {
    mapper.mockRestore()
  }
})

test("unmapped local shares ask, while mapped shares use the protected local root", async () => {
  const mapper = spyOn(realpathSync, "native").mockImplementation(
    realpathMapper((name) => {
      if (name.startsWith("\\\\localhost\\mapped\\")) return name.replace("\\\\localhost\\mapped", home)
      if (name.startsWith("\\\\localhost\\renamed\\"))
        return name.replace("localhost", "machine.example.test")
      if (name.startsWith("\\\\localhost\\")) throw new Error("share unavailable")
      return name
    }),
  )
  try {
    const policy = new Permissions({ protect: { platform: "win32", amiraHome: home, env: {} } })
    for (const target of [
      "\\\\localhost\\mapped\\settings.json",
      "\\\\localhost\\unknown\\settings.json",
      "\\\\localhost\\renamed\\settings.json",
      "\\\\localhost\\C$\\private-home\\settings.json",
    ]) {
      expect((await policy.check(write, { path: target }, cwd)).decision, target).toBe("ask")
    }
    expect(
      (await policy.check(write, { path: "\\\\remote-server\\share\\ordinary.txt" }, cwd)).decision,
    ).toBe("allow")
  } finally {
    mapper.mockRestore()
  }
})
