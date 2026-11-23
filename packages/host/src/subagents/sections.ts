import { defaultSections, type PromptSection } from "@amira/core"
import { instructionsSection, loadInstructions } from "../instructions.ts"

export function standardSections(cwd: string): PromptSection[] {
  return defaultSections({ cwd, project: instructionsSection(loadInstructions(cwd)) })
}
