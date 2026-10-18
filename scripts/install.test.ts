import { afterEach, expect, test } from "bun:test"
import { createHash, generateKeyPairSync } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { stageInstallers } from "./stage-installers.ts"

const temporary: string[] = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
async function directory() {
  const result = await mkdtemp(path.join(tmpdir(), "amira-install-"))
  temporary.push(result)
  return result
}

test("release installers embed the exact trusted Ed25519 public key, never a private key", async () => {
  const root = await directory()
  const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()
  await stageInstallers(root, key)
  for (const name of ["install.sh", "install.ps1"]) {
    const source = await readFile(path.join(root, name), "utf8")
    expect(source).toContain(key)
    expect(source).not.toContain("BEGIN PRIVATE KEY")
    expect(source).toContain("Manifest signature verification failed")
    expect(source).toContain("update-channels/next")
  }
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 })
    .publicKey.export({ type: "spki", format: "pem" })
    .toString()
  await expect(stageInstallers(root, rsa)).rejects.toThrow("Ed25519")
})

test("unconfigured installer key is explicit and PowerShell uses rename-copy-restore", async () => {
  const root = await directory()
  await stageInstallers(root, "")
  const shell = await readFile(path.join(root, "install.sh"), "utf8")
  expect(shell).toContain("public_key='' # AMIRA_RELEASE_PUBLIC_KEY")
  const windows = await readFile(path.join(root, "install.ps1"), "utf8")
  expect(windows).toContain("[IO.FileMode]::CreateNew")
  expect(windows).toContain("Move-Item -LiteralPath $bin -Destination $old")
  expect(windows).toContain("Move-Item -LiteralPath $old -Destination $bin")
  expect(windows).toContain("Archive SHA-256 mismatch")
  expect(windows).toContain("Executable version mismatch")
  expect(windows).toContain("New-Object Text.UTF8Encoding $false")
  expect(windows).toContain('ASCII.GetBytes("$PID`n")')
  expect(shell).toContain("OpenSSL Ed25519 verification is unavailable")
  expect(shell).toContain("Archive size mismatch")
  expect(shell).toContain("while IFS= read -r directory")
})

test("release workflow stages pinned installers and publishes next metadata without mutable releases", async () => {
  const source = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")
  const workflow = Bun.YAML.parse(source) as {
    jobs: Record<
      string,
      {
        permissions?: Record<string, string>
        steps: {
          uses?: string
          run?: string
          with?: { path?: string; ref?: string; "persist-credentials"?: boolean; "bun-version"?: string }
        }[]
      }
    >
  }
  expect(workflow.jobs.build!.steps.some((step) => step.run === "bun scripts/stage-installers.ts")).toBe(true)
  const assets = workflow.jobs.build!.steps.find((step) => step.with?.path?.includes("dist/manifest.json"))!
  expect(assets.with!.path).toContain("dist/install.sh")
  expect(assets.with!.path).toContain("dist/install.ps1")
  const channelJob = workflow.jobs["update-channel"]!
  const channel = channelJob.steps.map((step) => step.run ?? "").join("\n")
  expect(channel).toContain('bun scripts/publish-update-channel.ts publish --repo "$GH_REPO" --dist dist')
  expect(channel).not.toContain("bootstrap")
  expect(channel).not.toContain("python3")
  expect(channelJob.permissions).toEqual({ contents: "write" })
  const checkout = channelJob.steps.find((step) => step.uses?.startsWith("actions/checkout@"))!
  expect(checkout.with?.ref).toBe(`\${{ needs.plan.outputs.sha }}`)
  expect(checkout.with?.["persist-credentials"]).toBe(false)
  const bun = channelJob.steps.find((step) => step.uses?.startsWith("oven-sh/setup-bun@"))!
  expect(bun.with?.["bun-version"]).toBe("1.4.2")
  expect(source).toContain("Release signing secret does not match the compiled release public key")
})

for (const failure of [undefined, "sha", "size", "version", "lock"] as const) {
  test.skipIf(process.platform === "win32")(
    `Unix installer isolated local release: ${failure ?? "success"}`,
    async () => {
      const root = await directory()
      const executable = path.join(root, "payload", "amira")
      await mkdir(path.dirname(executable))
      await writeFile(executable, `#!/bin/sh\necho '${failure === "version" ? "1.2.0" : "1.2.3"} (stable)'\n`)
      await chmod(executable, 0o755)
      const archive = path.join(root, "archive.tar.gz")
      const tar = Bun.spawn(["tar", "-czf", archive, "-C", path.dirname(executable), "amira"], {
        stderr: "pipe",
      })
      expect(await tar.exited).toBe(0)
      const bytes = await readFile(archive)
      const target = `bun-${process.platform}-${process.arch}${process.platform === "linux" && process.arch === "x64" ? "-baseline" : ""}`
      const manifest = `${JSON.stringify(
        {
          version: "1.2.3",
          channel: "stable",
          artifacts: [
            {
              target,
              file: `amira-${target}.tar.gz`,
              size: bytes.length + (failure === "size" ? 1 : 0),
              sha256: failure === "sha" ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex"),
            },
          ],
        },
        null,
        2,
      )}\n`
      const requests: string[] = []
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const pathname = new URL(request.url).pathname
          requests.push(pathname)
          return new Response(pathname.endsWith("manifest.json") ? manifest : bytes)
        },
      })
      try {
        const source = await readFile(new URL("../install.sh", import.meta.url), "utf8")
        const script = path.join(root, "install.sh")
        await writeFile(
          script,
          source.replace(
            "https://github.com/CAMB-dev/Amira/releases",
            `http://127.0.0.1:${server.port}/releases`,
          ),
        )
        const home = path.join(root, 'home with spaces and "quotes"')
        await mkdir(home)
        if (failure === "lock") {
          await mkdir(path.join(home, ".local/share/amira"), { recursive: true })
          await writeFile(path.join(home, ".local/share/amira/update.lock"), "locked")
        }
        const child = Bun.spawn(["sh", script, "--version", "1.2.3"], {
          env: { ...process.env, HOME: home },
          stdout: "pipe",
          stderr: "pipe",
        })
        const stderr = await new Response(child.stderr).text()
        expect(await child.exited).toBe(failure ? 1 : 0)
        if (failure) {
          expect(stderr).toContain(
            failure === "sha"
              ? "SHA-256 mismatch"
              : failure === "size"
                ? "size mismatch"
                : failure === "version"
                  ? "version mismatch"
                  : "in progress",
          )
        } else {
          expect(await readlink(path.join(home, ".local/bin/amira"))).toBe(
            path.join(home, ".local/share/amira/versions/1.2.3/amira"),
          )
          const marker = JSON.parse(
            await readFile(path.join(home, ".local/share/amira/install.json"), "utf8"),
          )
          expect(marker.kind).toBe("single-file")
          expect(marker.version).toBe("1.2.3")
          expect(marker.bin).toBe(path.join(home, ".local/bin/amira"))
        }
        expect(requests).toHaveLength(failure === "lock" ? 0 : 2)
      } finally {
        await server.stop(true)
      }
    },
  )
}

for (const failure of [
  undefined,
  "sha",
  "size",
  "version",
  "marker",
  "rename",
  "file",
  "duplicate",
] as const) {
  test.skipIf(process.platform !== "win32")(
    `PowerShell installer isolated local release: ${failure ?? "success"}`,
    async () => {
      const root = await directory()
      const payload = path.join(root, "payload")
      await mkdir(payload)
      await writeFile(path.join(payload, "amira.exe"), "fixture executable; probe is injected")
      const archive = path.join(root, "fixture.zip")
      const zip = Bun.spawn(
        [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:AMIRA_FIXTURE_SOURCE, $env:AMIRA_FIXTURE_ARCHIVE)",
        ],
        {
          env: { ...process.env, AMIRA_FIXTURE_SOURCE: payload, AMIRA_FIXTURE_ARCHIVE: archive },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      expect(await zip.exited).toBe(0)
      const bytes = await readFile(archive)
      const artifact = {
        target: "bun-windows-x64-baseline",
        file: failure === "file" ? "other.zip" : "amira-bun-windows-x64-baseline.zip",
        size: bytes.length + (failure === "size" ? 1 : 0),
        sha256: failure === "sha" ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex"),
      }
      const manifest = {
        version: "1.2.3",
        channel: "stable",
        artifacts: failure === "duplicate" ? [artifact, artifact] : [artifact],
      }
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          return new URL(request.url).pathname.endsWith("manifest.json")
            ? Response.json(manifest)
            : new Response(bytes)
        },
      })
      try {
        let source = await readFile(new URL("../install.ps1", import.meta.url), "utf8")
        const probe = "$probed = & $candidate --version"
        const pathWrite =
          "[Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $binDirectory).TrimStart(';'), 'User')"
        expect(source).toContain(probe)
        expect(source).toContain(pathWrite)
        source = source
          .replace("https://github.com/CAMB-dev/Amira/releases", `http://127.0.0.1:${server.port}/releases`)
          .replace(
            probe,
            `$probed = '${failure === "version" ? "1.2.0" : "1.2.3"} (stable)'; $global:LASTEXITCODE = 0`,
          )
          .replace(pathWrite, "# User PATH writes are disabled in this isolated test.")
        if (failure === "marker") {
          source = source.replace(
            "Move-Item -LiteralPath $marker -Destination (Join-Path $root 'install.json') -Force",
            "throw 'simulated marker failure'",
          )
        }
        if (failure === "rename") {
          source = source.replace(
            "Move-Item -LiteralPath $bin -Destination $old",
            "throw 'simulated rename failure'",
          )
        }
        const script = path.join(root, "install.ps1")
        await writeFile(script, source)
        const local = path.join(root, "local app data")
        const install = path.join(local, "Amira")
        const bin = path.join(install, "bin", "amira.exe")
        await mkdir(path.dirname(bin), { recursive: true })
        await writeFile(bin, "previous executable")
        await writeFile(path.join(install, "install.json"), '{"version":"1.2.2"}')
        const child = Bun.spawn(
          [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            script,
            "-Version",
            "1.2.3",
          ],
          {
            env: { ...process.env, LOCALAPPDATA: local },
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const stderr = await new Response(child.stderr).text()
        const code = await child.exited
        expect({ code, error: failure ? undefined : stderr }).toEqual({
          code: failure ? 1 : 0,
          error: failure ? undefined : "",
        })
        if (failure) {
          expect(await readFile(bin, "utf8")).toBe("previous executable")
          expect(JSON.parse(await readFile(path.join(install, "install.json"), "utf8")).version).toBe("1.2.2")
        } else {
          const markerBytes = await readFile(path.join(install, "install.json"))
          expect(markerBytes.subarray(0, 3).toString("hex")).not.toBe("efbbbf")
          const marker = JSON.parse(markerBytes.toString("utf8"))
          expect(marker.version).toBe("1.2.3")
          expect(marker.bin).toBe(bin)
          expect(await readFile(bin, "utf8")).toBe("fixture executable; probe is injected")
        }
      } finally {
        await server.stop(true)
      }
    },
  )
}
