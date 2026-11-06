#!/usr/bin/env node
/**
 * Daily Pilot — تولید آیکون‌های اپ (اندروید + PWA)
 *
 * منبع تصویر: assets/brand/rouzsaz.png  (قابل تغییر با --src)
 *
 * خروجی‌ها:
 *   android/app/src/main/res/mipmap-<density>/ic_launcher.png            آیکون قدیمی (tile)
 *   android/app/src/main/res/mipmap-<density>/ic_launcher_round.png      آیکون گرد
 *   android/app/src/main/res/mipmap-<density>/ic_launcher_foreground.png لایهٔ آداپتیو (لوگو)
 *   public/icons/icon-192.png , icon-512.png                     PWA (purpose: any)
 *   public/icons/maskable-192.png , maskable-512.png             PWA (purpose: maskable)
 *   public/apple-touch-icon.png                                  iOS
 *   app/favicon.ico                                              favicon
 *
 * اجرا:
 *   node scripts/generate-icons.mjs
 *   node scripts/generate-icons.mjs --src ./assets/brand/rouzsaz.png
 *
 * پیاده‌سازی پردازش تصویر در scripts/generate-icons.py است و به
 * python3 + Pillow + numpy + scipy نیاز دارد.
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const SCRIPT = join(ROOT, "scripts", "generate-icons.py")
const DEFAULT_SRC = join(ROOT, "assets", "brand", "rouzsaz.png")

if (!existsSync(SCRIPT)) {
  console.error(`✖ اسکریپت پایتون پیدا نشد: ${relative(ROOT, SCRIPT)}`)
  process.exit(1)
}
const hasSrcArg = process.argv.some((a) => a === "--src" || a.startsWith("--src="))
if (!existsSync(DEFAULT_SRC) && !hasSrcArg) {
  console.error(
    `✖ تصویر منبع پیدا نشد: ${relative(ROOT, DEFAULT_SRC)}\n` +
      "  فایل برند را در assets/brand/rouzsaz.png بگذارید یا با --src مسیر بدهید.",
  )
  process.exit(1)
}

const python = ["python3", "python"].find((bin) => {
  const probe = spawnSync(bin, ["-c", "import PIL, numpy, scipy"], { stdio: "ignore" })
  return probe.status === 0
})

if (!python) {
  console.error(
    "✖ python3 با کتابخانه‌های Pillow و numpy و scipy پیدا نشد.\n" +
      "  نصب: pip install pillow numpy scipy",
  )
  process.exit(1)
}

const result = spawnSync(python, [SCRIPT, ...process.argv.slice(2)], {
  cwd: ROOT,
  stdio: "inherit",
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 0)
