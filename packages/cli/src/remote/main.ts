import path from "node:path"
import { createInterface } from "node:readline/promises"
import { amiraHome } from "@amira/core"
import { UsageError } from "../args.ts"
import { serverRelease } from "../server/identity.ts"
import { releaseBase } from "../update/manifest.ts"
import { releasePublicKey } from "../update/public-key.ts"
import { releaseServerArtifacts } from "./artifacts.ts"
import { attachRemoteUi } from "./attach-ui.ts"
import { parseRemoteCommand, runRemoteCommand } from "./command.ts"
import { compatibleRemoteDaemon } from "./install.ts"

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false
  const reader = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^(?:y|yes)$/i.test((await reader.question(`${question} [y/N] `)).trim())
  } finally {
    reader.close()
  }
}

/** Dispatched before ordinary startup: do not resolve local agent/project configuration here. */
export async function runRemoteCli(argv: string[]): Promise<number> {
  const help = !argv.length || (argv.length === 1 && ["help", "--help", "-h"].includes(argv[0]!))
  const parsed = help ? undefined : parseRemoteCommand(argv)
  if (parsed?.action === "attach" && !(process.stdin.isTTY && process.stdout.isTTY))
    throw new UsageError("remote attach needs a terminal; use remote add for noninteractive setup")
  if (parsed?.action === "attach" && process.env.TERM === "dumb")
    throw new UsageError("TERM=dumb cannot run the remote fullscreen UI")
  const localHome = amiraHome()
  let exitCode = 0
  await runRemoteCommand(argv, {
    localHome,
    release: serverRelease,
    publicKey: releasePublicKey,
    compatibleDaemon: compatibleRemoteDaemon,
    artifacts: releaseServerArtifacts({
      cacheDirectory: path.join(localHome, "remote", "artifacts"),
      baseUrl: `${releaseBase}/download/v${serverRelease.version}`,
      release: serverRelease,
      publicKey: releasePublicKey,
    }),
    interactive: !!process.stdin.isTTY && !!process.stdout.isTTY,
    consent: () => confirm("Install this server and allow automatic binary updates?"),
    write: (text) => {
      process.stdout.write(`${text}\n`)
    },
    attach: async (context) => {
      exitCode = await attachRemoteUi(context, {
        approve: (binding) =>
          confirm(
            `Allow remote provider ${binding.provider} (${binding.dialect}, expected ${binding.remoteOrigin ?? "unspecified endpoint"}) to use local provider ${binding.localProvider} at ${binding.endpointOrigin}? Requests are billed to that local account.`,
          ),
      })
    },
  })
  return exitCode
}
