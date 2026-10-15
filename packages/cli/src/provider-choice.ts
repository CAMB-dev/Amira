import { type ProviderAdmin, type ProviderFormInitial, providerVendorInitial } from "@amira/api"
import { UsageError } from "./args.ts"
import type { PrintIO } from "./print.ts"

/** Explicit vendor/protocol presets; without one, selection belongs inside the provider form. */
export async function providerChoice(
  admin: ProviderAdmin,
  name: string | undefined,
  io: PrintIO,
): Promise<ProviderFormInitial> {
  const protocols = admin.dialects()
  if (!name) return {}
  if (protocols.includes(name)) return { dialect: name }
  const vendors =
    (await admin.vendors?.({
      onLoading: () => io.stderr("Loading vendors from models.dev…\n"),
    })) ?? []
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
