import type { Component } from "../component.ts"
import type { StyleFn } from "../style.ts"
import { wrapText } from "../width.ts"

/** Wrapped text. May contain ANSI styles; an empty text takes no rows. */
export class Text implements Component {
  constructor(
    private text = "",
    private style?: StyleFn,
  ) {}

  getText(): string {
    return this.text
  }

  setText(text: string): void {
    this.text = text
  }

  append(text: string): void {
    this.text += text
  }

  render(width: number): string[] {
    if (this.text === "") return []
    return wrapText(this.style ? this.style(this.text) : this.text, width)
  }
}
