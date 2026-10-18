import { type ExtensionStatusMetadata, extensionStatusBadge } from "@amira/api"
import type { Theme } from "@amira/tui-kit"

/** Package maturity uses ASCII text in every glyph mode, with host theme tones only. */
export function styledExtensionStatusBadge(value: ExtensionStatusMetadata, theme: Theme): string {
  const badge = extensionStatusBadge(value)
  if (!badge) return ""
  return value.status === "experimental" ? theme.muted(badge) : theme.warning(badge)
}

/** Style only the host-supplied badge, keeping the original option as its answer identity. */
export function styledExtensionLabel(
  label: string,
  value: ExtensionStatusMetadata | undefined,
  theme: Theme,
  selected: boolean,
): string {
  const text = selected ? theme.accent : (value: string) => value
  const badge = value ? extensionStatusBadge(value) : ""
  const index = badge ? label.indexOf(badge) : -1
  if (!value || index === -1) return text(label)
  return (
    text(label.slice(0, index)) +
    styledExtensionStatusBadge(value, theme) +
    text(label.slice(index + badge.length))
  )
}
