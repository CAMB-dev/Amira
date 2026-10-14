import { instructionsSection, loadInstructions } from "../instructions.ts"
import { defaultSections, type PromptSection } from "../prompt.ts"

export function standardSections(cwd: string): PromptSection[] {
  return defaultSections({ cwd, project: instructionsSection(loadInstructions(cwd)) })
}
