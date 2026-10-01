import {
  type AvailableExtension,
  type CommandContext,
  type CommandDefinition,
  clip,
  type ExtensionAPI,
  type ExtensionProgress,
  type ExtensionScope,
  type ManagedExtension,
  type SelectSection,
  type ViewLine,
} from "@amira/api"

const USAGE =
  "usage: /ext [install <name>|update [name…]|remove <name>|disable <name>|enable <name>|search <query>] [--project]"
const SUBS = {
  install: "Install from the index",
  update: "Update installed packages",
  remove: "Remove a package",
  disable: "Stop loading a package",
  enable: "Load a disabled package",
  search: "Search the index",
}
type Subcommand = keyof typeof SUBS

export function parseExtArgs(args: string): { sub?: Subcommand; names: string[]; scope: ExtensionScope } {
  const words = args.split(/\s+/).filter(Boolean)
  const project = words.includes("--project")
  const rest = words.filter((s) => s !== "--project")
  const [sub, ...names] = rest
  if (!sub && !words.length) return { names: [], scope: "user" }
  if (
    !sub ||
    !Object.hasOwn(SUBS, sub) ||
    names.some((n) => n.startsWith("-")) ||
    words.filter((w) => w === "--project").length > 1
  )
    throw new Error(USAGE)
  if ((sub === "install" || sub === "remove" || sub === "disable" || sub === "enable") && names.length !== 1)
    throw new Error(USAGE)
  if (project && (sub === "disable" || sub === "enable" || sub === "search"))
    throw new Error(
      "disable and enable apply to both scopes in user settings; --project is for install, update and remove",
    )
  return { sub: sub as Subcommand, names, scope: project ? "project" : "user" }
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

export function extensionRows(installed: ManagedExtension[], available: AvailableExtension[]) {
  const names = new Set(installed.map((p) => p.name))
  const rows = installed.map((p) => ({
    label: `${p.name} ${p.version} · ${p.scope} · ${p.enabled ? "enabled" : "disabled"}${!p.trusted ? " · not trusted" : ""}${p.shadowed ? " · shadowed" : ""}${available.some((e) => e.name === p.name && Bun.semver.satisfies(e.version, "*") && Bun.semver.satisfies(p.version, "*") && Bun.semver.order(e.version, p.version) > 0) ? " · update available" : ""}`,
    description: oneLine(p.error ?? p.description),
    installed: p,
  }))
  const others = available
    .filter((e) => !names.has(e.name))
    .map((e) => ({ label: e.name, description: oneLine(e.description), available: e }))
  const sections: SelectSection[] = []
  if (rows.length)
    sections.push({ at: 0, title: "Installed", choose: "manage", keys: [{ key: "d", label: "details" }] })
  if (others.length)
    sections.push({
      at: rows.length,
      title: "Available from the index",
      choose: "install",
      keys: [{ key: "d", label: "details" }],
    })
  return {
    options: [...rows.map((r) => r.label), ...others.map((r) => r.label)],
    descriptions: [...rows.map((r) => r.description), ...others.map((r) => r.description)],
    sections,
    rows,
    others,
  }
}

export function extensionProgressLines(rows: ExtensionProgress[], width: number): ViewLine[] {
  return [
    { kind: "muted", text: clip("Extensions · working", width) },
    ...rows.map(
      (p): ViewLine => ({
        kind:
          p.phase === "failed"
            ? "error"
            : p.phase === "done"
              ? "success"
              : p.phase === "cancelled"
                ? "warning"
                : "accent",
        text: clip(
          `${oneLine(p.name)} · ${p.phase}${p.percent !== undefined ? ` ${Math.max(0, Math.min(100, Math.round(p.percent)))}%` : ""}${p.detail ? ` · ${oneLine(p.detail)}` : ""}`,
          width,
        ),
      }),
    ),
  ]
}

/** Uses host package operations: extensions themselves import only the public API. */
export function extensionCommand(api: ExtensionAPI): { command: CommandDefinition; running(): boolean } {
  let running = false
  let sessionId = ""
  const progress = new Map<string, ExtensionProgress>()
  api.registerPanel({
    id: "extensions",
    render: (opts) =>
      running && opts.sessionId === sessionId
        ? extensionProgressLines([...progress.values()], opts.width)
        : [],
  })
  const update = (p: ExtensionProgress) => {
    progress.set(p.name, p)
    api.requestRender()
  }
  const changed = (ctx: CommandContext, message: string) =>
    ctx.print(
      `${message} ${ctx.session.info().busy ? "Run /reload after the turn ends." : "Reload now? (/reload)"}`,
    )
  const command: CommandDefinition = {
    name: "ext",
    description: "Manage extensions: install, update, remove, enable, disable or search",
    args: {
      hint: "[subcommand] [name…] [--project]",
      async complete(prefix, ctx) {
        const admin = ctx.session.extensionAdmin
        const m = /^(\S+)\s+/.exec(prefix)
        if (!m) return Object.entries(SUBS).map(([value, description]) => ({ value, description }))
        const sub = m[1]!
        if (!admin || !["install", "update", "remove", "disable", "enable"].includes(sub)) return []
        const project = prefix.split(/\s+/).includes("--project")
        const before = prefix.slice(0, prefix.lastIndexOf(" ") + 1)
        if (sub === "install") {
          const list = await admin.search("", AbortSignal.timeout(2000))
          return list.extensions.map((p) => ({ value: `${before}${p.name}`, description: p.description }))
        }
        const installed = admin
          .list()
          .filter((p) =>
            sub === "disable"
              ? p.enabled
              : sub === "enable"
                ? !p.enabled
                : p.scope === (project ? "project" : "user"),
          )
        return [
          ...new Map(
            installed.map((p) => [
              p.name,
              { value: `${before}${p.name}`, description: `${p.version} · ${p.scope}` },
            ]),
          ).values(),
        ]
      },
    },
    async run(args, ctx) {
      if (running) throw new Error("Extension management is running; cancel it or wait for it to finish.")
      const parsed = parseExtArgs(args)
      const admin = ctx.session.extensionAdmin
      if (!admin) throw new Error("Extension management is unavailable on this host.")
      running = true
      sessionId = ctx.session.info().id
      progress.clear()
      const warnings = (messages: string[]) => {
        for (const message of messages) ctx.print(message, "warning")
      }
      const opts = {
        signal: ctx.signal,
        onProgress: update,
        log: (message: string) => ctx.print(message, "warning"),
      }
      let didChange = false
      const perform = async (sub: Subcommand, names: string[], scope: ExtensionScope) => {
        ctx.signal.throwIfAborted()
        const name = names[0]!
        switch (sub) {
          case "install": {
            update({ name, phase: "resolving" })
            const result = await admin.install(name, scope, opts)
            warnings(result.warnings)
            update({ name, phase: "done", detail: result.version })
            didChange = true
            changed(ctx, `Installed ${result.name} ${result.version} into ${scope} scope.`)
            if (
              scope === "project" &&
              admin.list().some((p) => p.name === result.name && p.scope === scope && !p.trusted)
            )
              ctx.print(
                "Project packages load once you trust the project: Amira asks at the next start (or run amira ext trust, then restart).",
                "warning",
              )
            break
          }
          case "update": {
            const selected = names.length
              ? names
              : admin
                  .list()
                  .filter((p) => p.scope === scope)
                  .map((p) => p.name)
            if (!selected.length) {
              ctx.print(`No packages in the ${scope} scope.`)
              break
            }
            for (const name of selected) update({ name, phase: "queued" })
            await admin.update(names, scope, opts, (r) => {
              update({ name: r.name, phase: r.error ? "failed" : "done", detail: r.error ?? r.version })
              if (r.error) ctx.print(`${r.name}: update failed, kept ${r.version}: ${r.error}`, "error")
              else if (r.changed) {
                didChange = true
                changed(ctx, `Updated ${r.name} to ${r.version}.`)
              } else ctx.print(`${r.name} is up to date (${r.version}).`)
            })
            break
          }
          case "remove":
            admin.remove(name, scope)
            didChange = true
            changed(ctx, `Removed ${name} from ${scope} scope.`)
            break
          case "disable":
          case "enable": {
            const enabled = sub === "enable"
            didChange = admin.setEnabled(name, enabled)
            const state = enabled ? "enabled" : "disabled"
            if (didChange) changed(ctx, `${name} is ${state} now (both scopes).`)
            else ctx.print(`${name} was already ${state}.`)
            break
          }
          case "search": {
            const result = await admin.search(names.join(" "), ctx.signal)
            warnings(result.warnings)
            ctx.print(
              result.extensions.length
                ? result.extensions
                    .map(
                      (p) => `${p.name} ${p.version}${p.description ? `\n  ${oneLine(p.description)}` : ""}`,
                    )
                    .join("\n")
                : "No extensions match in the index.",
            )
            break
          }
        }
      }
      try {
        if (parsed.sub) {
          await perform(parsed.sub, parsed.names, parsed.scope)
          return
        }
        const installed = admin.list()
        let available: AvailableExtension[] = []
        try {
          const loaded = await admin.search("", ctx.signal)
          available = loaded.extensions
          warnings(loaded.warnings)
        } catch (error) {
          ctx.signal.throwIfAborted()
          ctx.print(`Index unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning")
        }
        const rows = extensionRows(installed, available)
        if (!rows.options.length) {
          ctx.print("No installed extensions; the index has no available entries.")
          return
        }
        const pick = await ctx.ui.choose("Extensions", rows.options, {
          sections: rows.sections,
          descriptions: rows.descriptions,
          signal: ctx.signal,
        })
        if (!pick) return
        const item = rows.rows.find((r) => r.label === pick.option)?.installed
        const entry = rows.others.find((r) => r.label === pick.option)?.available
        if (pick.key === "d") {
          ctx.print(
            item
              ? `${item.name} ${item.version} · ${item.scope}\n${item.description}\nSource: ${item.source}\n${item.trusted ? "Trusted" : "Not trusted; packages will not load"}${item.error ? `\n${item.error}` : ""}`
              : `${entry!.name} ${entry!.version}\n${entry!.description}`,
          )
          return
        }
        if (item) {
          const action = await ctx.ui.select(
            `Manage ${item.name} (${item.scope})`,
            ["Update", item.enabled ? "Disable" : "Enable", "Remove", "Show details"],
            { signal: ctx.signal },
          )
          if (!action) return
          if (action === "Show details") {
            ctx.print(
              `${item.name} ${item.version} · ${item.scope}\n${item.description}\nSource: ${item.source}`,
            )
            return
          }
          if (
            action === "Remove" &&
            !(await ctx.ui.confirm(`Remove ${item.name} from ${item.scope} scope?`, undefined, {
              signal: ctx.signal,
            }))
          )
            return
          await perform(action.toLowerCase() as Subcommand, [item.name], item.scope)
        } else if (entry) {
          const scope = await ctx.ui.select(
            `Install ${entry.name} into which scope?`,
            ["User (default)", "Project"],
            { signal: ctx.signal },
          )
          if (scope) await perform("install", [entry.name], scope === "Project" ? "project" : "user")
        }
      } catch (error) {
        if (!ctx.signal.aborted) throw error
        for (const p of progress.values())
          if (p.phase !== "done" && p.phase !== "failed")
            update({ ...p, phase: "cancelled", detail: undefined })
        ctx.print(
          `Extension operation cancelled.${didChange ? " Completed changes are kept; run /reload after the turn ends." : ""}`,
          "warning",
        )
      } finally {
        running = false
        progress.clear()
        api.requestRender()
      }
    },
  }
  return { command, running: () => running }
}
