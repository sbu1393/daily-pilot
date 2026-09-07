/**
 * Daily Pilot — PWA icon generator (بدون وابستگی خارجی)
 *
 * خروجی:
 *   public/icons/icon-192.png          — گوشه‌گرد (purpose: any)
 *   public/icons/icon-512.png          — گوشه‌گرد (purpose: any)
 *   public/icons/maskable-192.png      — تمام‌صفحه (purpose: maskable)
 *   public/icons/maskable-512.png      — تمام‌صفحه (purpose: maskable)
 *   public/apple-touch-icon.png        — 180×180 بدون شفافیت (iOS)
 *
 * اجرا:  node scripts/generate-icons.mjs
 */
import { deflateSync } from "node:zlib"
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const OUT_DIR = join(ROOT, "public", "icons")

/* ---------- PNG encoder (RGBA) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, "ascii")
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0 // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))])
}

/* ---------- پالت رنگی برند ---------- */
const INDIGO = [99, 102, 241]
const VIOLET = [139, 92, 246]
const CHECK = [67, 56, 202] // indigo-700 برای تیک داخل دایره سفید

function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/**
 * مقداردهی اولیهٔ صحنه برای یک پیکسل نرمال‌شده (۰ تا ۱)
 * خروجی: [r, g, b, a] — با شفافیت گوشه‌گرد در صورت rounded=true
 */
function samplePixel(x, y, rounded) {
  const CORNER_R = 0.225

  // بدنه: گرادیان ایندیگو → بنفش (مورب)
  const inBody = rounded
    ? (() => {
        const qx = Math.abs(x - 0.5) - (0.5 - CORNER_R)
        const qy = Math.abs(y - 0.5) - (0.5 - CORNER_R)
        const ex = Math.max(qx, 0)
        const ey = Math.max(qy, 0)
        return ex * ex + ey * ey <= CORNER_R * CORNER_R
      })()
    : true

  if (!inBody) return [0, 0, 0, 0]

  const t = Math.min(1, Math.max(0, (x + y) / 2))
  let bg = lerp(INDIGO, VIOLET, t)

  // هایلایت ملایم بالای آیکون برای عمق بیشتر
  const topLight = Math.max(0, 1 - Math.hypot(x - 0.32, y - 0.28) / 0.62)
  bg = lerp(bg, [255, 255, 255], topLight * 0.1)

  const cx = x - 0.5
  const cy = y - 0.5
  const d = Math.hypot(cx, cy)

  // سایه‌ی نرم زیر دایره
  const DISC_R = 0.29
  if (!rounded && d > DISC_R && d < DISC_R + 0.055 && cy > 0.01) {
    const k = (d - DISC_R) / 0.055
    bg = lerp(bg, [15, 23, 42], (1 - k) * 0.16)
  }
  if (rounded && d > DISC_R && d < DISC_R + 0.045 && cy > 0) {
    const k = (d - DISC_R) / 0.045
    bg = lerp(bg, [15, 23, 42], (1 - k) * 0.14)
  }

  // دایرهٔ سفید مرکزی (نماد «تسک انجام‌شده»)
  if (d <= DISC_R) {
    let col = [255, 255, 255]

    // تیک: دو پاره‌خط — فاصله از چندخط
    const seg = (p, a, b) => {
      const abx = b[0] - a[0]
      const aby = b[1] - a[1]
      const t2 = Math.min(1, Math.max(0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / (abx * abx + aby * aby)))
      const px = a[0] + abx * t2
      const py = a[1] + aby * t2
      return Math.hypot(p[0] - px, p[1] - py)
    }

    const A = [0.42, 0.525]
    const B = [0.4925, 0.5975]
    const C = [0.615, 0.43]
    const distToCheck = Math.min(seg([x, y], A, B), seg([x, y], B, C))

    if (distToCheck <= 0.047) {
      // تیک با گرادیان کمرنگ بر اساس عمق
      const k = Math.min(1, Math.max(0, (d / DISC_R + 0.5) / 1.4))
      col = lerp(CHECK, [79, 70, 229], k)
    }

    return [col[0], col[1], col[2], 255]
  }

  return [bg[0], bg[1], bg[2], 255]
}

/**
 * رندر با فوق‌نمونه‌گیری (anti-aliasing) و کوچک‌سازی بلوکی
 */
function renderIcon(size, rounded) {
  const S = size <= 256 ? 4 : 3
  const big = size * S
  const buf = Buffer.alloc(big * big * 4)

  for (let py = 0; py < big; py++) {
    const y = (py + 0.5) / big
    for (let px = 0; px < big; px++) {
      const x = (px + 0.5) / big
      const [r, g, b, a] = samplePixel(x, y, rounded)
      const o = (py * big + px) * 4
      buf[o] = r
      buf[o + 1] = g
      buf[o + 2] = b
      buf[o + 3] = a
    }
  }

  // downsample
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const o = ((y * S + sy) * big + x * S + sx) * 4
          r += buf[o]
          g += buf[o + 1]
          b += buf[o + 2]
          a += buf[o + 3]
        }
      }
      const n = S * S
      const o = (y * size + x) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = Math.round(a / n)
    }
  }
  return out
}

/* ---------- خروجی ---------- */
mkdirSync(OUT_DIR, { recursive: true })

const jobs = [
  { file: join(OUT_DIR, "icon-192.png"), size: 192, rounded: true },
  { file: join(OUT_DIR, "icon-512.png"), size: 512, rounded: true },
  { file: join(OUT_DIR, "maskable-192.png"), size: 192, rounded: false },
  { file: join(OUT_DIR, "maskable-512.png"), size: 512, rounded: false },
  { file: join(ROOT, "public", "apple-touch-icon.png"), size: 180, rounded: false },
]

for (const job of jobs) {
  const rgba = renderIcon(job.size, job.rounded)
  writeFileSync(job.file, encodePng(job.size, rgba))
  console.log("✔", job.file, `(${job.size}×${job.size})`)
}
console.log("تمام شد ✓")
