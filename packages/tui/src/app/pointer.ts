import type { TuiSettings } from "@amira/api"
import { type MouseInput, type Terminal, translateMouse } from "@amira/tui-kit"
import { contentGeometry, contentMouse } from "../margins.ts"
import { mousePasteHint } from "../mouse-labels.ts"
import type { BottomArea } from "./bottom-area.ts"
import type { Composer } from "./composer.ts"
import type { OverlayManager } from "./overlays.ts"

/** Only pointer guidance is surfaced over modal content; ordinary composer notes stay behind it. */
export function activePointerHint(note: { text: string; until: number } | undefined): string | undefined {
  return note && Date.now() < note.until && note.text.startsWith("Clicks go to Amira here:")
    ? note.text
    : undefined
}

/** Match the card's terminal-sized render surface; other overlays stay content-relative. */
export function pointerGeometry(
  terminal: Pick<Terminal, "columns" | "rows">,
  settings: TuiSettings,
  overlays: Pick<OverlayManager, "overlayCard">,
) {
  const card = overlays.overlayCard(terminal.columns, { rows: terminal.rows })
  return contentGeometry(terminal.columns, terminal.rows, card ? { margin: 0, marginRows: 0 } : settings)
}

/** Route pointer ownership before the transcript can start a selection. */
export function routePointer(
  event: MouseInput,
  geometry: Parameters<typeof contentMouse>[1],
  overlays: OverlayManager,
  bottom: BottomArea,
  composer: Composer,
  showNote: (text: string) => void,
): boolean {
  const hint = mousePasteHint(event)
  if (hint) {
    showNote(hint)
    return true
  }
  const local = contentMouse(event, geometry)
  if (overlays.hasFullscreen) {
    if (local) overlays.handleInput(local)
    return true
  }
  const pointer = local ?? translateMouse(event, geometry.left, geometry.rows)
  if (overlays.handleDockInput(pointer)) return true
  const dialog = overlays.dialogs[0]
  if (!dialog) composer.prepareInput(event)
  // Even outside presses reach lists as negative coordinates, cancelling an earlier press.
  if (bottom.handlePointer(pointer, composer.handleCompletionKey)) return true
  // Open docks/cards own activation too; only wheel events may reach the transcript behind them.
  return !!(dialog || overlays.dock) && event.action !== "wheel"
}
