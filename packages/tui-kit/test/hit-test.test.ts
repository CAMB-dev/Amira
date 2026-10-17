import { expect, test } from "bun:test"
import { HitRegions, type MouseInput, translateMouse } from "../src/index.ts"

const mouse = (action: MouseInput["action"], x: number, y: number): MouseInput => ({
  type: "mouse",
  action,
  button: "left",
  x,
  y,
  ctrl: false,
  shift: false,
  alt: false,
})

test("hit regions translate margins and dock origin, and survive a redraw between press and release", () => {
  const regions = new HitRegions()
  regions.add("save", { x: 2, y: 1, width: 8, height: 1 })
  const local = (action: MouseInput["action"]) =>
    translateMouse(translateMouse(mouse(action, 9, 14), 3, 2), 0, 11)
  expect(regions.handle(local("press"))).toBeUndefined()
  regions.clear()
  regions.add("save", { x: 2, y: 1, width: 8, height: 1 })
  expect(regions.handle(local("release"))).toEqual({ id: "save", x: 4, y: 0, double: false })
})

test("release on another target or outside does not activate", () => {
  const regions = new HitRegions()
  regions.add("a", { x: 0, y: 0, width: 4, height: 1 })
  regions.add("b", { x: 0, y: 1, width: 4, height: 1 })
  regions.handle(mouse("press", 0, 0))
  expect(regions.handle(mouse("release", 0, 1))).toBeUndefined()
  regions.handle(mouse("press", 0, 0))
  expect(regions.handle(mouse("release", 4, 0))).toBeUndefined()
  expect(regions.handle(mouse("release", 0, 0))).toBeUndefined()
})

test("left clicks only, later regions win, and repeated clicks are target-specific", () => {
  const regions = new HitRegions()
  regions.add("field", { x: 0, y: 0, width: 20, height: 2 })
  regions.add("choice", { x: 2, y: 0, width: 4, height: 1 })
  const click = (x: number) => {
    regions.handle(mouse("press", x, 0))
    return regions.handle(mouse("release", x, 0))
  }
  expect(click(2)?.id).toBe("choice")
  expect(click(3)?.double).toBe(true)
  expect(click(7)?.double).toBe(false)
  expect(regions.handle({ ...mouse("press", 7, 0), button: "right" })).toBeUndefined()
  expect(regions.handle({ ...mouse("release", 7, 0), button: "middle" })).toBeUndefined()
  regions.reset()
  expect(regions.handle(mouse("release", 7, 0))).toBeUndefined()
})
