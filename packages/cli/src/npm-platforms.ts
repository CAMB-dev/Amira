/** The npm binary package contract, also embedded in the dependency-free launcher at staging. */
export const npmPlatforms = [
  { target: "bun-windows-x64-baseline", name: "amira-win32-x64", os: "win32", cpu: "x64" },
  { target: "bun-linux-x64-baseline", name: "amira-linux-x64", os: "linux", cpu: "x64" },
  { target: "bun-linux-arm64", name: "amira-linux-arm64", os: "linux", cpu: "arm64" },
  { target: "bun-darwin-x64", name: "amira-darwin-x64", os: "darwin", cpu: "x64" },
  { target: "bun-darwin-arm64", name: "amira-darwin-arm64", os: "darwin", cpu: "arm64" },
] as const
