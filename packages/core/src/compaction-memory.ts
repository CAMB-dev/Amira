import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { CompactionMemory, RememberedFailures } from "@amira/ai"

/**
 * Keeps the ways of server-side compaction an endpoint turned out not to support in a JSON
 * file (by default ~/.amira/cache/native-compaction.json), so later runs skip them too. A
 * missing or damaged file is an empty memory; deleting it makes Amira try every way again.
 */
export function fileCompactionMemory(file: string): CompactionMemory {
  return {
    load(): RememberedFailures {
      try {
        const v = JSON.parse(readFileSync(file, "utf8"))
        return v && typeof v === "object" && !Array.isArray(v) ? v : {}
      } catch {
        return {}
      }
    },
    save(failures) {
      mkdirSync(path.dirname(file), { recursive: true })
      // Written aside and renamed, so two runs saving at once leave one whole file.
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, `${JSON.stringify(failures, null, 2)}\n`)
      renameSync(tmp, file)
    },
  }
}
