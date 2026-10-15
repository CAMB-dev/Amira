import { expect, test } from "bun:test"
import { installSource, upgradeCommand } from "../src/install-source.ts"
import { npmPlatforms } from "../src/npm-platforms.ts"

for (const [source, paths] of Object.entries({
  npm: [
    "/usr/local/lib/node_modules/amira-linux-x64/amira",
    "/usr/local/lib/node_modules/amira-linux-x64/bin/amira",
    "/project/node_modules/amira-darwin-arm64/amira",
    "C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\amira-win32-x64\\amira.exe",
  ],
  pnpm: [
    "/project/node_modules/.pnpm/amira-linux-arm64@1.2.3/node_modules/amira-linux-arm64/amira",
    "/home/test/.local/share/pnpm/global/5/node_modules/amira-linux-x64/amira",
    "C:\\Users\\test\\AppData\\Local\\pnpm\\global\\5\\node_modules\\.pnpm\\amira-win32-x64@1.2.3\\node_modules\\amira-win32-x64\\amira.exe",
  ],
  bun: [
    "/home/test/.bun/install/global/node_modules/amira-linux-x64/amira",
    "C:\\Users\\test\\.bun\\install\\global\\node_modules\\amira-win32-x64\\amira.exe",
  ],
  releases: [
    "/home/test/.local/bin/amira",
    "/tmp/amira-bun-linux-x64-baseline/amira",
    "C:\\tools\\amira.exe",
    "/tmp/node_modules/not-amira/amira",
  ],
  dev: ["/usr/bin/bun", "/usr/bin/node", "C:\\tools\\bun.exe", "C:\\Program Files\\nodejs\\node.exe"],
})) {
  test(`detects ${source} on Windows and POSIX without filesystem access`, () => {
    for (const executable of paths) expect<string>(installSource(executable)).toBe(source)
  })
}

test("install detection follows every supported platform package, not arbitrary amira-* directories", () => {
  for (const { name, os } of npmPlatforms) {
    const binary = os === "win32" ? "amira.exe" : "amira"
    expect(installSource(`/project/node_modules/${name}/bin/${binary}`)).toBe("npm")
    expect(installSource(`C:\\project\\node_modules\\${name}\\bin\\${binary}`)).toBe("npm")
  }
  expect(installSource("/project/node_modules/amira-win32-arm64/bin/amira.exe")).toBe("releases")
})

test("managed installs provide only their package manager upgrade command", () => {
  expect(upgradeCommand("npm")).toBe("npm i -g amira")
  expect(upgradeCommand("pnpm")).toBe("pnpm add -g amira")
  expect(upgradeCommand("bun")).toBe("bun add -g amira")
  expect(upgradeCommand("releases")).toBeUndefined()
  expect(upgradeCommand("dev")).toBeUndefined()
})
