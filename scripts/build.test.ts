import { expect, test } from "bun:test"
import pkg from "../packages/cli/package.json" with { type: "json" }
import { buildOptions, targets } from "./build.ts"

test("build defaults to the package version and stable channel", () => {
  expect(buildOptions([]).version).toBe(pkg.version)
  expect(buildOptions([]).channel).toBe("stable")
})

test("all seven targets accept nightly metadata", () => {
  const options = buildOptions(["--all", "--version", "0.1.0-nightly.20261011.2", "--channel", "next"])
  expect(options.targets).toEqual([...targets])
  expect(options.version).toBe("0.1.0-nightly.20261011.2")
  expect(options.channel).toBe("next")
  for (const target of targets) expect(buildOptions(["--target", target]).targets).toEqual([target])
})

test("invalid or incomplete build options fail before compiling", () => {
  for (const argv of [
    ["--target", "bun-freebsd-x64"],
    ["--target"],
    ["--version", "../bad"],
    ["--version", "--all"],
    ["--channel", "nightly"],
    ["--unknown"],
  ]) {
    expect(() => buildOptions(argv)).toThrow()
  }
})
