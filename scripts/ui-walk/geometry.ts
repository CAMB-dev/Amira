// Unicode U+2500–257F, in code-point order. Arms are up/right/down/left:
// 0 absent, l light (single), h heavy, d double. Specials are dashed/rounded/diagonal.
const BOXES = [
  "0l0l", // ─
  "0h0h", // ━
  "l0l0", // │
  "h0h0", // ┃
  "hl3", // ┄
  "hh3", // ┅
  "vl3", // ┆
  "vh3", // ┇
  "hl4", // ┈
  "hh4", // ┉
  "vl4", // ┊
  "vh4", // ┋
  "0ll0", // ┌
  "0hl0", // ┍
  "0lh0", // ┎
  "0hh0", // ┏
  "00ll", // ┐
  "00lh", // ┑
  "00hl", // ┒
  "00hh", // ┓
  "ll00", // └
  "lh00", // ┕
  "hl00", // ┖
  "hh00", // ┗
  "l00l", // ┘
  "l00h", // ┙
  "h00l", // ┚
  "h00h", // ┛
  "lll0", // ├
  "lhl0", // ┝
  "hll0", // ┞
  "llh0", // ┟
  "hlh0", // ┠
  "hhl0", // ┡
  "lhh0", // ┢
  "hhh0", // ┣
  "l0ll", // ┤
  "l0lh", // ┥
  "h0ll", // ┦
  "l0hl", // ┧
  "h0hl", // ┨
  "h0lh", // ┩
  "l0hh", // ┪
  "h0hh", // ┫
  "0lll", // ┬
  "0llh", // ┭
  "0hll", // ┮
  "0hlh", // ┯
  "0lhl", // ┰
  "0lhh", // ┱
  "0hhl", // ┲
  "0hhh", // ┳
  "ll0l", // ┴
  "ll0h", // ┵
  "lh0l", // ┶
  "lh0h", // ┷
  "hl0l", // ┸
  "hl0h", // ┹
  "hh0l", // ┺
  "hh0h", // ┻
  "llll", // ┼
  "lllh", // ┽
  "lhll", // ┾
  "lhlh", // ┿
  "hlll", // ╀
  "llhl", // ╁
  "hlhl", // ╂
  "hllh", // ╃
  "hhll", // ╄
  "llhh", // ╅
  "lhhl", // ╆
  "hhlh", // ╇
  "lhhh", // ╈
  "hlhh", // ╉
  "hhhl", // ╊
  "hhhh", // ╋
  "hl2", // ╌
  "hh2", // ╍
  "vl2", // ╎
  "vh2", // ╏
  "0d0d", // ═
  "d0d0", // ║
  "0dl0", // ╒
  "0ld0", // ╓
  "0dd0", // ╔
  "00ld", // ╕
  "00dl", // ╖
  "00dd", // ╗
  "ld00", // ╘
  "dl00", // ╙
  "dd00", // ╚
  "l00d", // ╛
  "d00l", // ╜
  "d00d", // ╝
  "ldl0", // ╞
  "dld0", // ╟
  "ddd0", // ╠
  "l0ld", // ╡
  "d0dl", // ╢
  "d0dd", // ╣
  "0dld", // ╤
  "0ldl", // ╥
  "0ddd", // ╦
  "ld0d", // ╧
  "dl0l", // ╨
  "dd0d", // ╩
  "ldld", // ╪
  "dldl", // ╫
  "dddd", // ╬
  "rdr", // ╭
  "rdl", // ╮
  "rul", // ╯
  "rur", // ╰
  "/", // ╱
  "\\", // ╲
  "x", // ╳
  "000l", // ╴
  "l000", // ╵
  "0l00", // ╶
  "00l0", // ╷
  "000h", // ╸
  "h000", // ╹
  "0h00", // ╺
  "00h0", // ╻
  "0h0l", // ╼
  "l0h0", // ╽
  "0l0h", // ╾
  "h0l0", // ╿
] as const

function rect(x: number, y: number, width: number, height: number): string {
  return `M${x} ${y}h${width}v${height}h${-width}Z`
}

function blocks(code: number, width: number, height: number): string {
  const index = code - 0x2580
  const columns = Math.ceil(width)
  const coverage = new Float64Array(columns * Math.ceil(height))
  function fill(x: number, y: number, w: number, h: number): void {
    // Integrate the exact rectangle area in each boundary pixel. Resvg's path
    // antialiasing quantizes e.g. a 2.375px eighth to 2.25px, changing its area.
    for (let row = Math.floor(y); row < Math.ceil(y + h); row++) {
      for (let column = Math.floor(x); column < Math.ceil(x + w); column++) {
        const dx = Math.max(0, Math.min(column + 1, x + w) - Math.max(column, x))
        const dy = Math.max(0, Math.min(row + 1, y + h) - Math.max(row, y))
        coverage[row * columns + column]! += dx * dy
      }
    }
  }
  if (index === 0) fill(0, 0, width, height / 2)
  else if (index <= 8) fill(0, height * (1 - index / 8), width, (height * index) / 8)
  else if (index <= 15) fill(0, 0, (width * (16 - index)) / 8, height)
  else if (index === 16) fill(width / 2, 0, width / 2, height)
  else if (index <= 19) {
    // A cell-local stipple, not a font texture: exactly 1/4, 1/2 or 3/4 coverage.
    const dx = width / 10
    const dy = height / 20
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 10; x++) {
        const rank = y % 2 === 0 ? (x % 2 === 0 ? 0 : 2) : x % 2 === 0 ? 3 : 1
        if (rank < index - 16) fill(x * dx, y * dy, dx, dy)
      }
    }
  } else if (index === 20) fill(0, 0, width, height / 8)
  else if (index === 21) fill((width * 7) / 8, 0, width / 8, height)
  else {
    // Bits: upper-left, upper-right, lower-left, lower-right.
    const mask = [4, 8, 1, 13, 9, 7, 11, 2, 6, 14][index - 22]!
    for (let quadrant = 0; quadrant < 4; quadrant++) {
      if (mask & (1 << quadrant)) {
        fill((quadrant % 2) * (width / 2), Math.floor(quadrant / 2) * (height / 2), width / 2, height / 2)
      }
    }
  }
  const paths = new Map<number, string>()
  for (let row = 0; row < Math.ceil(height); row++) {
    for (let column = 0; column < columns; ) {
      const opacity = Math.min(1, coverage[row * columns + column]!)
      let end = column + 1
      while (end < columns && Math.min(1, coverage[row * columns + end]!) === opacity) end++
      if (opacity > 0) paths.set(opacity, (paths.get(opacity) ?? "") + rect(column, row, end - column, 1))
      column = end
    }
  }
  return [...paths]
    .map(([opacity, path]) => `<path d="${path}" fill-opacity="${opacity}" shape-rendering="crispEdges"/>`)
    .join("")
}

function box(descriptor: string, width: number, height: number): string {
  const cx = width / 2
  const cy = height / 2
  const light = Math.min(width, height) / 5
  const heavy = light * 2
  const thin = light / 2
  const offset = light * 0.75
  if (descriptor.length === 3 && descriptor[0] !== "r") {
    const vertical = descriptor[0] === "v"
    const count = Number(descriptor[2])
    const thickness = descriptor[1] === "h" ? heavy : light
    const length = vertical ? height : width
    const step = length / count
    let path = ""
    for (let dash = 0; dash < count; dash++) {
      // Half-gap at either edge so adjacent dashed cells retain the same cadence.
      const start = dash * step + step / 8
      path += vertical
        ? rect(cx - thickness / 2, start, thickness, step * 0.75)
        : rect(start, cy - thickness / 2, step * 0.75, thickness)
    }
    return `<path d="${path}"/>`
  }
  if (descriptor[0] === "r") {
    const sx = descriptor[2] === "r" ? 1 : -1
    const sy = descriptor[1] === "d" ? 1 : -1
    const radius = Math.min(cx, cy) / 2
    const edgeX = sx > 0 ? width : 0
    const edgeY = sy > 0 ? height : 0
    return `<path d="M${cx} ${edgeY}V${cy + sy * radius}Q${cx} ${cy} ${cx + sx * radius} ${cy}H${edgeX}" fill="none" stroke="currentColor" stroke-width="${light}"/>`
  }
  if (descriptor.length === 1) {
    const path =
      (descriptor !== "\\" ? `M${width} 0L0 ${height}` : "") +
      (descriptor !== "/" ? `M0 0L${width} ${height}` : "")
    return `<path d="${path}" fill="none" stroke="currentColor" stroke-width="${light}"/>`
  }

  let path = ""
  for (let direction = 0; direction < 4; direction++) {
    const weight = descriptor[direction]!
    if (weight === "0") continue
    const vertical = direction % 2 === 0
    const sign = direction === 0 || direction === 3 ? -1 : 1
    const center = vertical ? cy : cx
    const across = vertical ? cx : cy
    const length = vertical ? height : width
    const negative = descriptor[vertical ? 3 : 0]!
    const positive = descriptor[vertical ? 1 : 2]!
    const opposite = descriptor[(direction + 2) % 4]!
    const thickness = weight === "d" ? thin : weight === "h" ? heavy : light
    for (const lane of weight === "d" ? [-offset, offset] : [0]) {
      let end = center
      let cap = thickness / 2
      if (weight === "d") {
        const doubles = Number(negative === "d") + Number(positive === "d")
        if (doubles === 2) end += sign * offset
        else if (doubles === 1) {
          const perpendicularSign = positive === "d" ? 1 : -1
          if (opposite === "d") {
            if (Math.sign(lane) === perpendicularSign) end += sign * offset
          } else end += lane * perpendicularSign * sign
        } else {
          // Mixed single/double joins meet the single stem, including heavy stems.
          cap = Math.max(cap, negative === "h" || positive === "h" ? heavy / 2 : light / 2)
        }
      } else {
        if (negative === "d" || positive === "d") end -= sign * offset
        cap = Math.max(cap, negative === "h" || positive === "h" ? heavy / 2 : light / 2)
        // A lone half-line ends precisely at the cell center.
        if (negative === "0" && positive === "0" && opposite === "0") cap = 0
      }
      const start = sign < 0 ? 0 : end - cap
      const finish = sign < 0 ? end + cap : length
      path += vertical
        ? rect(across + lane - thickness / 2, start, thickness, finish - start)
        : rect(start, across + lane - thickness / 2, finish - start, thickness)
    }
  }
  // One filled path unions overlapping arms before the outer dim opacity is applied.
  return `<path d="${path}"/>`
}

/** Internal screenshot geometry; undefined leaves ordinary characters to the font renderer. */
export function cellGeometry(
  chars: string,
  x: number,
  y: number,
  width = 10,
  height = 20,
): string | undefined {
  if (chars.length !== 1) return undefined
  const code = chars.charCodeAt(0)
  if (code < 0x2500 || code > 0x259f) return undefined
  const content = code < 0x2580 ? box(BOXES[code - 0x2500]!, width, height) : blocks(code, width, height)
  // A local viewport clips thick strokes at the cell edges, while neighboring cells join flush.
  return `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" overflow="hidden">${content}</svg>`
}
