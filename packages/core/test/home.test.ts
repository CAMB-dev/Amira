import { expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { amiraHome } from "../src/home.ts"

test("AMIRA_HOME overrides ~/.amira", () => {
  expect(amiraHome({})).toBe(path.join(os.homedir(), ".amira"))
  expect(amiraHome({ AMIRA_HOME: "x/y" })).toBe(path.resolve("x/y"))
})
