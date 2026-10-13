import { spawn } from "node:child_process"
import path from "node:path"

export interface DaemonLaunch {
  readonly error?: Error
  kill(): void
  release(): void
}

function psString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** Windows tool hosts kill their whole Job Object when a shell call ends, even detached children. */
async function windowsDaemon(root: string): Promise<DaemonLaunch> {
  const command = [process.execPath, path.join(import.meta.dir, "daemon.ts"), root]
    .map((arg) => `"${arg}"`)
    .join(" ")
  // WMI creates a same-user process outside the caller's Job Object. No scheduled task,
  // admin rights, user profile script, console window or persistent service is involved.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; CreateFlags = [uint32]0x08000200 }",
    `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psString(command)}; CurrentDirectory = ${psString(path.resolve(import.meta.dir, "../.."))}; ProcessStartupInformation = $startup }`,
    "$result | ConvertTo-Json -Compress",
  ].join("; ")
  const helper = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [output, diagnostic, code] = await Promise.all([
    new Response(helper.stdout).text(),
    new Response(helper.stderr).text(),
    helper.exited,
  ])
  if (code !== 0) throw new Error(`Cannot launch Windows UI walk daemon through WMI: ${diagnostic}`)
  const result = JSON.parse(output) as { ReturnValue: number; ProcessId: number }
  if (result.ReturnValue !== 0 || !result.ProcessId) {
    throw new Error(`Windows WMI daemon launch failed: ${output}`)
  }
  // Hold the OS process handle during startup: a failed launch must never kill a reused PID.
  // This is Bun FFI to the system DLL, not a native addon or compiler dependency.
  const { dlopen, FFIType } = await import("bun:ffi")
  const kernel = dlopen("kernel32.dll", {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    TerminateProcess: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  })
  const handle = kernel.symbols.OpenProcess(0x0001, 0, result.ProcessId)
  return {
    kill() {
      if (handle) kernel.symbols.TerminateProcess(handle, 1)
    },
    release() {
      if (handle) kernel.symbols.CloseHandle(handle)
      kernel.close()
    },
  }
}

export async function launchDaemon(root: string): Promise<DaemonLaunch> {
  if (process.platform === "win32") return windowsDaemon(root)
  const daemon = spawn(process.execPath, [path.join(import.meta.dir, "daemon.ts"), root], {
    cwd: path.resolve(import.meta.dir, "../.."),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, BUN_INSPECT: "", BUN_OPTIONS: "", NODE_OPTIONS: "" },
  })
  let error: Error | undefined
  daemon.on("error", (reason) => {
    error = reason
  })
  daemon.unref()
  return {
    get error() {
      return error
    },
    kill: () => {
      daemon.kill()
    },
    release() {},
  }
}
