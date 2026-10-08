import {
  DIALECT_NOTES,
  type FormSpec,
  type FormValues,
  type ProviderAdmin,
  type ProviderFormInitial,
  providerVendorInitial,
  providerVendorLabel,
} from "@amira/api"
import { UsageError } from "./args.ts"
import type { PrintIO } from "./print.ts"
import type { ReadLine } from "./provider-cli.ts"

const CUSTOM = "Custom (choose a protocol)"
type Ask = (spec: FormSpec) => Promise<FormValues | undefined>

/** A vendor or an explicit protocol; protocol names win on a clash. */
export async function providerChoice(
  admin: ProviderAdmin,
  name: string | undefined,
  ask: Ask,
  io: PrintIO,
  readLine: ReadLine,
  interactive: boolean,
): Promise<ProviderFormInitial | undefined> {
  const protocols = admin.dialects()
  if (name && protocols.includes(name)) return { dialect: name }
  const vendors =
    (await admin.vendors?.({
      onLoading: () => io.stderr("Loading vendors from models.dev…\n"),
    })) ?? []
  if (name) {
    if (!vendors.length) {
      throw new UsageError(
        `Vendor catalog unavailable (offline?); cannot look up "${name}". Choose a protocol instead: ${protocols.join(", ")}`,
      )
    }
    const vendor = vendors.find((v) => v.id === name)
    if (!vendor) {
      const close = closeIds(
        name,
        vendors.map((v) => v.id),
      )
      throw new UsageError(
        `unknown vendor or protocol "${name}"; protocols: ${protocols.join(", ")}` +
          (close.length ? `; close vendor ids: ${close.join(", ")}` : ""),
      )
    }
    return providerVendorInitial(admin, vendor)
  }
  if (vendors.length) {
    const labels = vendors.map(providerVendorLabel)
    let id: string | undefined
    if (interactive) {
      const values = await ask({
        title: "Choose a vendor",
        fields: [
          {
            type: "select",
            id: "vendor",
            label: "Vendor",
            options: [
              ...vendors.map((v, i) => ({ value: v.id, label: labels[i]! })),
              { value: "", label: CUSTOM },
            ],
            default: vendors[0]!.id,
          },
        ],
        submitLabel: "Continue",
      })
      if (!values) return undefined
      id = String(values.vendor ?? "")
    } else {
      io.stderr(
        `\nChoose a vendor\n${labels.map((s, i) => `  ${i + 1}) ${s}`).join("\n")}\n  ${labels.length + 1}) ${CUSTOM}\n`,
      )
      for (;;) {
        const answer = await readLine("Type a vendor id, number, or custom: ")
        if (answer === undefined) return undefined
        const value = answer.trim()
        const n = Number(value)
        if (value.toLowerCase() === "custom" || value === CUSTOM || n === vendors.length + 1) {
          id = ""
          break
        }
        const vendor =
          vendors.find((v) => v.id === value) ?? (Number.isInteger(n) && n >= 1 ? vendors[n - 1] : undefined)
        if (vendor) {
          id = vendor.id
          break
        }
        const close = closeIds(
          value,
          vendors.map((v) => v.id),
        )
        io.stderr(
          `Unknown vendor id "${value}".${close.length ? ` Close matches: ${close.join(", ")}.` : " Type a listed id or custom."}\n`,
        )
      }
    }
    if (id) {
      const vendor = vendors.find((v) => v.id === id)
      if (!vendor) throw new UsageError(`unknown vendor "${id}"`)
      return providerVendorInitial(admin, vendor)
    }
  } else {
    io.stderr("Vendor catalog unavailable; choose a custom provider.\n")
  }
  // Custom keeps the existing form, with its protocol selected first.
  if (!interactive) {
    io.stderr(
      `\nWhich protocol does the provider speak?\n${protocols.map((p, i) => `  ${i + 1}) ${p} — ${DIALECT_NOTES[p] ?? "protocol"}`).join("\n")}\n`,
    )
    for (;;) {
      const answer = await readLine(`Choose 1-${protocols.length} [1]: `)
      if (answer === undefined) return undefined
      const value = answer.trim()
      const n = value ? Number(value) : 1
      const dialect = protocols.includes(value) ? value : protocols[n - 1]
      if (dialect) return { dialect }
      io.stderr(`Type a protocol name or a number from 1 to ${protocols.length}.\n`)
    }
  }
  const values = await ask({
    title: "Which protocol does the provider speak?",
    submitLabel: "Continue",
    fields: [
      {
        type: "select",
        id: "dialect",
        label: "Protocol",
        options: protocols.map((value) => ({ value, description: DIALECT_NOTES[value] })),
        default: protocols[0],
      },
    ],
  })
  return values ? { dialect: String(values.dialect) } : undefined
}

/** Substrings and nearby spellings, without making an unknown id an implicit choice. */
function closeIds(typed: string, ids: string[]): string[] {
  const query = typed.toLowerCase()
  if (!query) return []
  return ids
    .map((id) => ({ id, distance: distance(query, id.toLowerCase()) }))
    .filter((v) => v.id.toLowerCase().includes(query) || v.distance <= Math.max(2, query.length / 3))
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
    .slice(0, 5)
    .map((v) => v.id)
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1]
    for (let j = 0; j < b.length; j++) {
      next.push(Math.min(next[j]! + 1, row[j + 1]! + 1, row[j]! + Number(a[i] !== b[j])))
    }
    row = next
  }
  return row[b.length]!
}
