import type { SkillDefinition, SkillInfo } from "@amira/api"

export class SkillConflictError extends Error {}

interface Registered {
  def: SkillDefinition
  source: string
}

/**
 * Skills the user runs as `$<name>`, registered by extensions. Like commands, a name holds a
 * stack: `override: true` replaces the current skill and removing it restores the one below.
 */
export class SkillRegistry {
  #skills = new Map<string, Registered[]>()

  /** Throws SkillConflictError for a taken name without `override`, and Error for an invalid name. */
  register(def: SkillDefinition, source: string): () => void {
    if (!def.name || /[\s$]/.test(def.name)) {
      throw new Error(`invalid skill name "${def.name}": no spaces or "$"`)
    }
    const stack = this.#skills.get(def.name) ?? []
    const top = stack.at(-1)
    if (top && !def.override) {
      throw new SkillConflictError(
        `skill $${def.name} from ${source} conflicts with the one from ${top.source}; set override: true to replace it`,
      )
    }
    const entry = { def, source }
    stack.push(entry)
    this.#skills.set(def.name, stack)
    return () => {
      const rest = (this.#skills.get(def.name) ?? []).filter((e) => e !== entry)
      if (rest.length) this.#skills.set(def.name, rest)
      else this.#skills.delete(def.name)
    }
  }

  get(name: string): Registered | undefined {
    return this.#skills.get(name)?.at(-1)
  }

  /** The current skill of every name, sorted by name. */
  list(): SkillInfo[] {
    return [...this.#skills.values()]
      .map((s) => s.at(-1)!)
      .map(({ def, source }) => ({
        name: def.name,
        description: def.description,
        hint: def.hint ?? "[arguments]",
        source,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }
}

/**
 * Splits "$name args" into its parts. Whether it runs a skill depends on the name: "$100 is
 * the price" names no skill and is sent as a message.
 */
export function parseSkillLine(text: string): { name: string; args: string } | undefined {
  const m = /^\$([^\s$]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  return m ? { name: m[1]!, args: (m[2] ?? "").trim() } : undefined
}
