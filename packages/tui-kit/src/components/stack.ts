import type { Component, RenderContext } from "../component.ts"

/** Stacks children vertically. */
export class Stack implements Component {
  children: Component[]

  constructor(children: Component[] = []) {
    this.children = children
  }

  add(child: Component, index = this.children.length): void {
    this.children.splice(index, 0, child)
  }

  remove(child: Component): void {
    const i = this.children.indexOf(child)
    if (i !== -1) this.children.splice(i, 1)
  }

  has(child: Component): boolean {
    return this.children.includes(child)
  }

  render(width: number, ctx: RenderContext): string[] {
    return this.children.flatMap((c) => c.render(width, ctx))
  }
}
