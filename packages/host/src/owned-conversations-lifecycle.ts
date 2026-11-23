import { writeAtomicFile } from "@amira/core/internal"

export type OwnedLifecycleState = "active" | "archiving" | "archived"

export function isOwnedLifecycleState(value: unknown): value is OwnedLifecycleState {
  return value === "active" || value === "archiving" || value === "archived"
}

export const writeOwnedFile = writeAtomicFile
