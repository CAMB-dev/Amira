import { type HitRect, HitRegions } from "../hit-test.ts"
import type { MouseInput } from "../keys.ts"
import type { FormFieldHit } from "./form-field.ts"

export interface FormHit extends HitRect {
  focus: string
  kind: FormFieldHit["kind"] | "editor" | "confirm"
  index?: number
  value?: string
  /** Row relative to the textarea's rendered editor, before form scrolling. */
  editorY?: number
}

interface FormViewport {
  x?: number
  y: number
  rows: number
  width: number
  length: number
}

/** Maps rendered form controls to shared hit regions without owning field state. */
export class FormMouse {
  viewport: FormViewport = { y: 0, rows: 0, width: 0, length: 0 }
  private hits = new HitRegions()
  private rendered: FormHit[] = []
  private targets = new Map<string, FormHit>()

  reset(): void {
    this.hits.reset()
  }

  at(e: MouseInput): FormHit | undefined {
    return this.rendered.findLast(
      (hit) => e.x >= hit.x && e.x < hit.x + hit.width && e.y >= hit.y && e.y < hit.y + hit.height,
    )
  }

  handle(e: MouseInput): { target: FormHit; x: number; y: number } | undefined {
    const click = this.hits.handle(e)
    const target = click && this.targets.get(click.id)
    if (!click || !target) return
    return { target, x: click.x, y: (target.editorY ?? 0) + click.y }
  }

  render(
    width: number,
    outputRows: number,
    hits: FormHit[],
    footerHits: FormHit[],
    viewport: FormViewport & { top: number; bodyWidths: number[]; preview?: string },
  ): void {
    this.hits.clear()
    this.targets.clear()
    this.rendered = []
    this.viewport = viewport
    const add = (hit: FormHit, right = width) => {
      const x = Math.max(0, hit.x)
      const size = Math.min(right, hit.x + hit.width) - x
      if (size <= 0 || hit.y < 0 || hit.y >= outputRows) return
      const clipped = { ...hit, x, width: size, height: 1 }
      const id = JSON.stringify([hit.focus, hit.kind, hit.value ?? hit.index, hit.editorY])
      this.hits.add(id, clipped)
      this.targets.set(id, clipped)
      this.rendered.push(clipped)
    }
    for (const hit of hits) {
      for (let y = hit.y; y < hit.y + hit.height; y++) {
        const row = y - viewport.top
        if (row >= 0 && row < viewport.rows) add({ ...hit, y: viewport.y + row }, viewport.bodyWidths[row])
      }
    }
    if (viewport.preview)
      for (let row = 0; row < viewport.rows; row++)
        add({
          focus: viewport.preview,
          kind: "focus",
          x: viewport.width + 3,
          y: viewport.y + row,
          width: width - viewport.width - 3,
          height: 1,
        })
    for (const hit of footerHits) add({ ...hit, y: viewport.y + viewport.rows + hit.y })
  }
}
