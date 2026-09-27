/**
 * 用代码生成应用图标（PNG / ICNS / ICO），不引任何依赖。
 *
 * 为什么不用 AI 生图再裁：
 *   - 生成图上带着平台水印，裁掉会破坏构图；
 *   - 缩放后边缘会糊，小尺寸（16px）细节全丢；
 *   - 颜色没法精确对齐品牌色，也没法复现。
 *
 * 这里用 4 倍超采样自绘（4096 → 各目标尺寸盒式降采样），
 * 形状用有符号距离场描述，所以任意尺寸都是干净抗锯齿的。
 * 想调构图直接改下面的常量重跑即可。
 *
 * 用法：npm run icon:build
 */
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { deflateSync } from 'zlib'

/* ------------------------------------------------------------------ */
/*  几何常量（1024 画布坐标系）                                          */
/* ------------------------------------------------------------------ */

const SIZE = 1024
/** 超采样倍数：先画大图再降采样，等于免费拿到高质量抗锯齿 */
const SS = 4
const W = SIZE * SS

/** macOS 图标规范：圆角方形占 1024 的约 80%，四周留白 */
const BG = { half: 412, n: 5 } // n 是超椭圆指数，5 接近 Apple 的 squircle

const DOC = { x: 288, y: 222, w: 448, h: 580, r: 48 }
/** 右上角折角大小 */
const FOLD = 118

/**
 * 知识图谱：菱形四节点。
 * 半径与线宽刻意压得比「看起来刚好」更细一档 —— 太粗的话四个圆会和连线
 * 糊成一整块色斑，反而看不出「节点 + 关系」的结构。
 */
const NODE_R = 44
const NODES: [number, number][] = [
  [512, 356], // 上
  [394, 530], // 左
  [630, 530], // 右
  [512, 668] // 下
]
const LINKS: [number, number][] = [
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 3]
]
const LINK_W = 26

/** 品牌色（与 tailwind.config.js 保持一致） */
const C_BG_FROM = '#4338CA' // brand.deep
const C_BG_TO = '#6366F1' // brand
const C_DOC = '#FFFFFF'
const C_DOC_TO = '#F1F2FA'
const C_FOLD = '#DCE0F4'
const C_NODE = '#2DD4BF' // accent
const C_SHADOW = '#0B0B0F'

/* ------------------------------------------------------------------ */
/*  颜色工具                                                            */
/* ------------------------------------------------------------------ */

type RGBA = [number, number, number, number]

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16)
  ]
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  const k = Math.max(0, Math.min(1, t))
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

/** 标准的 source-over 合成 */
function over(dst: RGBA, src: RGBA): RGBA {
  const a = src[3] + dst[3] * (1 - src[3])
  if (a <= 0) return [0, 0, 0, 0]
  return [
    (src[0] * src[3] + dst[0] * dst[3] * (1 - src[3])) / a,
    (src[1] * src[3] + dst[1] * dst[3] * (1 - src[3])) / a,
    (src[2] * src[3] + dst[2] * dst[3] * (1 - src[3])) / a,
    a
  ]
}

/* ------------------------------------------------------------------ */
/*  形状：有符号距离场                                                   */
/* ------------------------------------------------------------------ */

/** 圆角矩形的有符号距离：内部为负，外部为正 */
function sdRoundedRect(
  px: number,
  py: number,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): number {
  const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r)
  const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r)
  const ax = Math.max(qx, 0)
  const ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

/** 超椭圆（Apple squircle 的近似）内部判定 */
function insideSquircle(px: number, py: number): boolean {
  const dx = Math.abs(px - SIZE / 2) / BG.half
  const dy = Math.abs(py - SIZE / 2) / BG.half
  return Math.pow(dx, BG.n) + Math.pow(dy, BG.n) <= 1
}

/** 点到线段的距离，用来画带圆头的粗连线 */
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const len2 = vx * vx + vy * vy
  const t = len2 > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2)) : 0
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t))
}

/** 折角区域：右上角被切掉的那块三角 */
function inFoldCut(px: number, py: number): boolean {
  const u = (px - (DOC.x + DOC.w - FOLD)) / FOLD
  const v = (py - DOC.y) / FOLD
  return u > 0 && v < 1 && u > v
}

/** 折角翻起来的那个小三角（视觉上是纸的背面） */
function inFoldFlap(px: number, py: number): boolean {
  const u = (px - (DOC.x + DOC.w - FOLD)) / FOLD
  const v = (py - DOC.y) / FOLD
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 && !(u > v)
}

/* ------------------------------------------------------------------ */
/*  着色：逐像素合成                                                    */
/* ------------------------------------------------------------------ */

const BG_FROM = parseHex(C_BG_FROM)
const BG_TO = parseHex(C_BG_TO)
const DOC_FROM = parseHex(C_DOC)
const DOC_TO = parseHex(C_DOC_TO)
const FOLD_C = parseHex(C_FOLD)
const NODE_C = parseHex(C_NODE)
const SHADOW_C = parseHex(C_SHADOW)

function shade(px: number, py: number): RGBA {
  let out: RGBA = [0, 0, 0, 0]
  if (!insideSquircle(px, py)) return out

  // 背景：沿对角线的线性渐变 + 左上角一点柔和高光（纯渐变会显得很平）
  const t = (px - (SIZE / 2 - BG.half) + (py - (SIZE / 2 - BG.half))) / (BG.half * 4)
  const bg = mix(BG_FROM, BG_TO, t)
  out = [bg[0], bg[1], bg[2], 1]

  const glow = Math.max(0, 1 - Math.hypot(px - 320, py - 300) / 620)
  if (glow > 0) {
    const k = glow * glow * 0.16
    out = [
      out[0] + (255 - out[0]) * k,
      out[1] + (255 - out[1]) * k,
      out[2] + (255 - out[2]) * k,
      1
    ]
  }

  // 纸张投影：用距离场做柔和外扩，比堆多层矩形更干净
  const sd = sdRoundedRect(px, py, DOC.x, DOC.y + 16, DOC.w, DOC.h, DOC.r)
  if (sd > 0) {
    const falloff = Math.max(0, 1 - sd / 46)
    if (falloff > 0) out = over(out, [SHADOW_C[0], SHADOW_C[1], SHADOW_C[2], falloff * falloff * 0.34])
  }

  // 纸张本体（白色 → 极淡的冷灰，避免大面积纯白显得平）
  if (sdRoundedRect(px, py, DOC.x, DOC.y, DOC.w, DOC.h, DOC.r) <= 0 && !inFoldCut(px, py)) {
    const g = mix(DOC_FROM, DOC_TO, (py - DOC.y) / DOC.h)
    out = over(out, [g[0], g[1], g[2], 1])
  }

  /*
   * 折角背面。必须再裁一次纸张圆角：折角三角本身是直角，
   * 不裁的话它会盖住纸张那个被磨圆的角，看起来像另外贴上去的一块。
   */
  if (inFoldFlap(px, py) && sdRoundedRect(px, py, DOC.x, DOC.y, DOC.w, DOC.h, DOC.r) <= 0) {
    out = over(out, [FOLD_C[0], FOLD_C[1], FOLD_C[2], 1])
  }

  // 知识图谱连线：先画线再画节点，节点圆心会盖住线头，接缝更干净
  for (const [a, b] of LINKS) {
    const [ax, ay] = NODES[a]
    const [bx, by] = NODES[b]
    if (distToSegment(px, py, ax, ay, bx, by) <= LINK_W / 2) {
      out = over(out, [NODE_C[0], NODE_C[1], NODE_C[2], 1])
    }
  }
  for (const [nx, ny] of NODES) {
    if (Math.hypot(px - nx, py - ny) <= NODE_R) {
      out = over(out, [NODE_C[0], NODE_C[1], NODE_C[2], 1])
    }
  }

  return out
}

/* ------------------------------------------------------------------ */
/*  位图与降采样                                                        */
/* ------------------------------------------------------------------ */

/** 渲染超采样大图，返回 RGBA 缓冲区 */
function renderBig(): Uint8Array {
  const buf = new Uint8Array(W * W * 4)
  for (let y = 0; y < W; y++) {
    const py = (y + 0.5) / SS
    for (let x = 0; x < W; x++) {
      const px = (x + 0.5) / SS
      const [r, g, b, a] = shade(px, py)
      const i = (y * W + x) * 4
      buf[i] = Math.round(r)
      buf[i + 1] = Math.round(g)
      buf[i + 2] = Math.round(b)
      buf[i + 3] = Math.round(a * 255)
    }
  }
  return buf
}

/**
 * 盒式降采样。
 * 逐像素计算源区域的平均值——直接丢弃采样点会让小尺寸出现锯齿。
 */
function resample(src: Uint8Array, srcSize: number, dstSize: number): Uint8Array {
  const dst = new Uint8Array(dstSize * dstSize * 4)
  const ratio = srcSize / dstSize
  for (let y = 0; y < dstSize; y++) {
    const y0 = Math.floor(y * ratio)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * ratio))
    for (let x = 0; x < dstSize; x++) {
      const x0 = Math.floor(x * ratio)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * ratio))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * srcSize + sx) * 4
          // 预乘 alpha 后再平均，否则透明边缘会渗出黑边
          const alpha = src[i + 3] / 255
          r += src[i] * alpha
          g += src[i + 1] * alpha
          b += src[i + 2] * alpha
          a += src[i + 3]
          n++
        }
      }
      const o = (y * dstSize + x) * 4
      const avgA = a / n
      const scale = avgA > 0 ? 255 / avgA : 0
      dst[o] = Math.min(255, Math.round((r / n) * scale))
      dst[o + 1] = Math.min(255, Math.round((g / n) * scale))
      dst[o + 2] = Math.min(255, Math.round((b / n) * scale))
      dst[o + 3] = Math.round(avgA)
    }
  }
  return dst
}

/* ------------------------------------------------------------------ */
/*  PNG 编码                                                            */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, Buffer.from(data)])))
  return Buffer.concat([len, typeBuf, Buffer.from(data), crc])
}

function encodePng(rgba: Uint8Array, size: number): Buffer {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter: None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array())
  ])
}

/* ------------------------------------------------------------------ */
/*  ICO（Windows）：PNG 负载直接塞进容器即可，Vista 以后都支持            */
/* ------------------------------------------------------------------ */

function encodeIco(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  const entries: Buffer[] = []
  const blobs: Buffer[] = []
  let offset = 6 + images.length * 16

  for (const img of images) {
    const e = Buffer.alloc(16)
    e[0] = img.size >= 256 ? 0 : img.size // 0 表示 256
    e[1] = img.size >= 256 ? 0 : img.size
    e[2] = 0
    e[3] = 0
    e.writeUInt16LE(1, 4) // color planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(img.png.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    blobs.push(img.png)
    offset += img.png.length
  }

  return Buffer.concat([header, ...entries, ...blobs])
}

/* ------------------------------------------------------------------ */
/*  主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * 调试用：直接打印若干坐标的合成结果。
 * 缩略图上看不清折角这类细节，与其猜不如量。
 */
function probe(): void {
  const points: [number, number, string][] = [
    [736, 240, '纸张右上角外侧（折角切口，应为背景靛蓝）'],
    [700, 265, '切口区域'],
    [660, 310, '折角背面（应为浅灰紫）'],
    [600, 250, '折角左侧的纸张本体（应为白）'],
    [512, 356, '顶部节点圆心（应为青色）'],
    [512, 470, '菱形中心空白（应为白）'],
    [200, 200, '背景左上角（应为渐变靛蓝）']
  ]
  for (const [x, y, label] of points) {
    const [r, g, b, a] = shade(x, y)
    const hex = `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
    console.log(`   (${String(x).padStart(4)},${String(y).padStart(4)})  ${hex}  α=${a.toFixed(2)}  ${label}`)
  }
}

function main(): void {
  if (process.argv.includes('--probe')) {
    probe()
    return
  }

  const outDir = resolve(process.cwd(), 'build')
  const iconset = join(outDir, 'icon.iconset')

  console.log('渲染中（4 倍超采样）…')
  const big = renderBig()

  // 一张大图降采样出所有需要的尺寸，保证各尺寸完全一致
  const need = [16, 32, 48, 64, 128, 256, 512, 1024]
  const bitmaps = new Map<number, Uint8Array>()
  for (const size of need) {
    bitmaps.set(size, size === SIZE ? resample(big, W, SIZE) : resample(big, W, size))
  }

  mkdirSync(outDir, { recursive: true })
  rmSync(iconset, { recursive: true, force: true })
  mkdirSync(iconset, { recursive: true })

  const write = (path: string, size: number): Buffer => {
    const png = encodePng(bitmaps.get(size)!, size)
    writeFileSync(path, png)
    return png
  }

  // electron-builder 会优先用 icon.png（Linux / 通用）
  write(join(outDir, 'icon.png'), 1024)

  // macOS iconset：文件名是 iconutil 约定的
  const pairs: [string, number][] = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024]
  ]
  for (const [name, size] of pairs) writeFileSync(join(iconset, name), encodePng(bitmaps.get(size)!, size))

  // Windows ICO
  const ico = encodeIco(
    [16, 32, 48, 64, 128, 256].map((size) => ({
      size,
      png: encodePng(bitmaps.get(size)!, size)
    }))
  )
  writeFileSync(join(outDir, 'icon.ico'), ico)

  // macOS ICNS（iconutil 是系统自带的，不需要装依赖）
  if (process.platform === 'darwin') {
    try {
      execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(outDir, 'icon.icns')])
      console.log('已生成 icon.icns')
    } catch (err) {
      console.warn('iconutil 失败，跳过 icns（不影响 png/ico）', err)
    }
  }
  rmSync(iconset, { recursive: true, force: true })

  console.log(`
已生成到 build/：
  icon.png    1024×1024
  icon.ico    16/32/48/64/128/256（Windows）
  ${process.platform === 'darwin' ? 'icon.icns  macOS' : 'icon.icns  需要 macOS 才能生成'}

调整构图：改 scripts/make-icon.ts 顶部的几何常量后重跑本命令。`)
}

main()

/** 让 esbuild 在 CJS 打包下不把 node:path 的 dirname 摇掉 */
void dirname
