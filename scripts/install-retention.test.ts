import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import path from "node:path"
import { RETENTION_GATE } from "../packages/cli/src/update/retention-gate.ts"
import { createVersionLease, VERSION_LEASE_HEADER } from "../packages/cli/src/update/version-leases.ts"
import { tryFileLock } from "../packages/core/src/file-lock.ts"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "amira-install-retention-"))
  directories.push(root)
  for (let patch = 0; patch <= 4; patch++) {
    const directory = path.join(root, "versions", `1.2.${patch}`)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, "amira.exe"), `1.2.${patch}`)
    await utimes(directory, 1_000_000 + patch, 1_000_000 + patch)
  }
  return root
}

async function cleanup(
  root: string,
  unknownLiveness = false,
  beforeWait?: () => Promise<void>,
  shell = process.platform === "win32" ? "powershell" : "sh",
) {
  const windows = shell === "powershell"
  const name = windows ? "install.ps1" : "install.sh"
  const source = await readFile(new URL(`../${name}`, import.meta.url), "utf8")
  expect(source).toContain(VERSION_LEASE_HEADER)
  let body: string
  if (windows) {
    body = source.slice(source.indexOf("    # Shared leases/"), source.indexOf("    $userPath ="))
    if (unknownLiveness)
      body = body.replace(
        "$owner = [Diagnostics.Process]::GetProcessById($leasePid)",
        "throw 'simulated process permission error'",
      )
    let gate = source.slice(source.indexOf("function Enter-RetentionGate"), source.indexOf("$releases ="))
    if (beforeWait)
      gate = gate.replace(
        "    $gatePath =",
        "    [IO.File]::WriteAllText((Join-Path $Root 'gate-ready'), 'ready')\n    $gatePath =",
      )
    body = `$ErrorActionPreference = 'Stop'\n$root = $env:AMIRA_RETENTION_ROOT\n$versions = Join-Path $root 'versions'\n$Version = '1.2.4'\n$versionPattern = '\\A(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-rc\\.(0|[1-9][0-9]*))?\\z'\n${gate}\n$retention = Enter-RetentionGate $root\ntry {\n${body}\n} finally { Exit-RetentionGate $retention $root }`
  } else {
    const valid = source.match(/valid_version\(\) \{[\s\S]*?\n\}/)![0]
    body = source.slice(source.indexOf("# Session leases share"), source.indexOf("printf 'Installed Amira"))
    const liveness = unknownLiveness
      ? "kill() { return 1; }; ps() { echo 'permission denied' >&2; return 1; }\n"
      : ""
    let gate = source.match(/take_retention_gate\(\) \{[\s\S]*?\n\}/)![0]
    if (beforeWait) gate = gate.replace("  attempts=0", '  printf ready > "$root/gate-ready"\n  attempts=0')
    const release = source.match(/release_retention_gate\(\) \{[\s\S]*?\n\}/)![0]
    body = `#!/bin/sh\nset -eu\nroot=$AMIRA_RETENTION_ROOT\nversion=1.2.4\nstaging=$root/staging\nretention_lock=$root/retention.lock\nretention_owned=false\nmkdir -p "$staging"\n${valid}\n${gate}\n${release}\ntrap release_retention_gate EXIT\ntake_retention_gate\n${liveness}${body}`
  }
  expect(body.length).toBeGreaterThan(500)
  const script = path.join(root, windows ? "cleanup.ps1" : "cleanup.sh")
  await writeFile(script, body)
  const child = Bun.spawn(
    windows
      ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script]
      : ["sh", script],
    {
      env: { ...process.env, AMIRA_RETENTION_ROOT: root },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  if (beforeWait) await beforeWait()
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  return readdir(path.join(root, "versions"))
}

test("installer retains additional live versions, then prunes them after leases release", async () => {
  const root = await fixture()
  const leases = [await createVersionLease(root, "1.2.0"), await createVersionLease(root, "1.2.1")]
  expect(await cleanup(root)).toHaveLength(5)
  await Promise.all(leases.map((lease) => lease.release()))
  expect(await cleanup(root)).toEqual(["1.2.2", "1.2.3", "1.2.4"])
}, 30_000)

test("installer retires only proven dead local owners", async () => {
  for (const kind of ["dead", "foreign", "malformed", "unknown"] as const) {
    const root = await fixture()
    await createVersionLease(root, "1.2.0", {
      pid: 2_147_483_647,
      ...(kind === "foreign" ? { host: "foreign-host" } : {}),
    })
    if (kind === "malformed") {
      const directory = path.join(root, "leases", "1.2.0")
      await writeFile(path.join(directory, (await readdir(directory))[0]!), "unrecognized lease")
    }
    const versions = await cleanup(root, kind === "unknown")
    expect(versions.includes("1.2.0")).toBe(kind !== "dead")
  }
}, 30_000)

test.each([...(process.platform === "win32" ? ["powershell"] : []), ...(Bun.which("sh") ? ["sh"] : [])])(
  "%s installer waits for the shared short gate and observes a published lease",
  async (shell) => {
    const root = await fixture()
    const lock = tryFileLock(path.join(root, RETENTION_GATE), 600_000, undefined, true)!
    let released = false
    try {
      const versions = await cleanup(
        root,
        false,
        async () => {
          const deadline = Date.now() + 10_000
          while (!(await Bun.file(path.join(root, "gate-ready")).exists())) {
            if (Date.now() >= deadline) throw new Error("Installer did not attempt the retention gate")
            await Bun.sleep(5)
          }
          await mkdir(path.join(root, "leases", "1.2.0"), { recursive: true })
          await writeFile(
            path.join(root, "leases", "1.2.0", "publishing.lease"),
            `${VERSION_LEASE_HEADER}\n${hostname().toLowerCase()}\n${process.pid}\n1.2.0\n`,
          )
          lock.release()
          released = true
        },
        shell,
      )
      expect(versions).toContain("1.2.0")
    } finally {
      if (!released) lock.release()
    }
  },
  30_000,
)

test("installer refuses to prune with an unexpected lease root layout", async () => {
  const root = await fixture()
  await writeFile(path.join(root, "leases"), "unrecognized root")
  expect(await cleanup(root)).toHaveLength(5)
}, 30_000)
