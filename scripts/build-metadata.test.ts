import { expect, test } from "bun:test"
import { buildOptions, targets as buildTargets } from "./build.ts"
import { targets, validateBuildMetadata } from "./build-metadata.ts"

test("build metadata accepts canonical stable, prerelease and build-suffix versions", () => {
  expect(buildTargets).toBe(targets)
  for (const version of [
    "0.0.0",
    "1.2.3",
    "1.2.3-rc.1",
    "1.2.3-nightly.20261015.7",
    "1.2.3+001",
    "1.2.3-rc.1+build.7",
  ]) {
    for (const channel of ["stable", "next"] as const) {
      const metadata = { version, channel, targets: [...targets] }
      expect(validateBuildMetadata(metadata)).toEqual(metadata)
      expect(buildOptions(["--all", "--version", version, "--channel", channel])).toEqual(metadata)
    }
  }
})

test("the shared metadata boundary rejects malformed versions, channels and target arrays", () => {
  const valid = { version: "1.2.3", channel: "stable", targets: [targets[0]] }
  for (const value of [
    null,
    undefined,
    true,
    "1.2.3",
    [],
    {},
    { ...valid, version: undefined },
    { ...valid, channel: undefined },
  ]) {
    expect(() => validateBuildMetadata(value)).toThrow()
  }
  for (const version of [
    "v1.2.3",
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2",
    "1.2.3-",
    "1.2.3-rc.01",
    "1.2.3+",
    "1.2.3+a..b",
    "1.2.3\n",
    "../1.2.3",
  ]) {
    expect(() => validateBuildMetadata({ ...valid, version })).toThrow()
    expect(() => buildOptions(["--version", version])).toThrow()
  }
  for (const channel of ["nightly", "", null, 1]) {
    expect(() => validateBuildMetadata({ ...valid, channel })).toThrow()
  }
  for (const selected of [
    undefined,
    [],
    "bun-linux-x64",
    [targets[0], targets[0]],
    ["bun-freebsd-x64"],
    ["../bad"],
    [null],
    [1],
  ]) {
    expect(() => validateBuildMetadata({ ...valid, targets: selected })).toThrow()
  }
})
