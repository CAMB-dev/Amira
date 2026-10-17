#!/usr/bin/env bun
import path from "node:path"
import { parseArgs } from "node:util"
import { list, positiveInteger, request, type StartOptions, start } from "./session.ts"

const usage = `Usage: bun scripts/ui-walk/walk.ts <command>
  start <name> [--cols 100 --rows 32] [--theme name] [--scenario file]
               [--extension local-dir ...] [--idle-timeout ms]
               [-- ...amira args]
  --extension loads trusted local test code only, copied into the temporary home.
  keys <name> <keys...>         enter esc ctrl+o alt+v up tab text:/model paste:...
  resize <name> <cols> <rows>
  wait <name> [--idle ms | --text string] [--timeout ms]
  shot <name> <out.png>
  text <name>                  Current visible screen, with line numbers
  ansi <name>                  Current visible screen as ANSI
  stop <name>                  Kill this session's tree and remove its temporary files
  list`

function amiraArgs(args: string[]): string[] {
  // Keep cwd, providers, extensions, package loading and resume under harness control.
  const boolean = new Set(["--fullscreen", "--no-builtins"])
  const valued = new Set(["--thinking", "--permission-mode", "--disable-tools", "--shell"])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--") break // Remaining words are an initial prompt, not flags.
    if (!arg.startsWith("-")) continue
    if (boolean.has(arg)) continue
    if (valued.has(arg) && args[i + 1] && !args[i + 1]!.startsWith("-")) {
      i++
      continue
    }
    throw new Error(`Amira argument is not allowed in the offline harness: ${arg}`)
  }
  return args
}

export async function main(argv: string[]): Promise<void> {
  const [command, name, ...args] = argv
  if (command === "list" && !name) {
    console.log(await list())
    return
  }
  if (command === "help" || command === "--help" || !command) {
    console.log(usage)
    return
  }
  if (!name) throw new Error(`Missing session name\n${usage}`)
  if (command === "start") {
    const separator = args.indexOf("--")
    const parsed = parseArgs({
      args: separator < 0 ? args : args.slice(0, separator),
      options: {
        cols: { type: "string" },
        rows: { type: "string" },
        theme: { type: "string" },
        scenario: { type: "string" },
        extension: { type: "string", multiple: true },
        "idle-timeout": { type: "string" },
      },
    }).values
    const options: StartOptions = {
      cols: positiveInteger(parsed.cols ?? 100, "cols", 500),
      rows: positiveInteger(parsed.rows ?? 32, "rows", 200),
      theme: parsed.theme,
      scenario: parsed.scenario ? path.resolve(parsed.scenario) : undefined,
      extensions: parsed.extension?.map((directory) => path.resolve(directory)),
      idleTimeout: positiveInteger(parsed["idle-timeout"] ?? 600_000, "idle-timeout"),
      args: amiraArgs(separator < 0 ? [] : args.slice(separator + 1)),
    }
    const state = await start(name, options)
    console.log(JSON.stringify({ name, pid: state.pid, childPid: state.childPid, root: state.root }))
    return
  }
  if (command === "keys" && args.length) {
    process.stdout.write(await (await request(name, { command, keys: args })).text())
    return
  }
  if (command === "resize" && args.length === 2) {
    process.stdout.write(
      await (
        await request(name, {
          command,
          cols: positiveInteger(args[0]!, "cols", 500),
          rows: positiveInteger(args[1]!, "rows", 200),
        })
      ).text(),
    )
    return
  }
  if (command === "wait") {
    const parsed = parseArgs({
      args,
      options: { idle: { type: "string" }, text: { type: "string" }, timeout: { type: "string" } },
    }).values
    if (parsed.idle !== undefined && parsed.text !== undefined)
      throw new Error("Use --idle or --text, not both")
    process.stdout.write(
      await (
        await request(name, {
          command,
          idle: parsed.idle ? positiveInteger(parsed.idle, "idle") : undefined,
          text: parsed.text,
          timeout: positiveInteger(parsed.timeout ?? 30_000, "timeout"),
        })
      ).text(),
    )
    return
  }
  if (command === "shot" && args.length === 1) {
    const response = await request(name, { command })
    const out = path.resolve(args[0]!)
    await Bun.write(out, await response.arrayBuffer())
    console.log(out)
    return
  }
  if (["text", "ansi", "stop"].includes(command) && !args.length) {
    process.stdout.write(await (await request(name, { command })).text())
    return
  }
  throw new Error(`Invalid command or arguments\n${usage}`)
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
