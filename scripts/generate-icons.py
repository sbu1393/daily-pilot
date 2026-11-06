#!/usr/bin/env python3
"""Daily Pilot — Android + PWA icon generator.

منبع تصویر: assets/brand/rouzsaz.png (یا --src)
خروجی‌ها:
  android/app/src/main/res/mipmap-*/ic_launcher.png            آیکون قدیمی (tile گوشه‌گرد)
  android/app/src/main/res/mipmap-*/ic_launcher_round.png      آیکون گرد
  android/app/src/main/res/mipmap-*/ic_launcher_foreground.png لایهٔ foreground آداپتیو (لوگو، شفاف)
  public/icons/icon-*.png                                      PWA (purpose: any)
  public/icons/maskable-*.png                                  PWA maskable (تمام‌صفحه)
  public/apple-touch-icon.png                                  iOS
  app/favicon.ico                                              favicon چندسایز

اجرا:
  python3 scripts/generate-icons.py [--src PATH] [--root PATH]
"""
from __future__ import annotations

import argparse
import os

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

# ---------------------------------------------------------------- geometry
DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
FOREGROUND = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}

# logo-layer size relative to the canvas (logo content radius = 0.4657 * scale)
LOGO_SCALE = {
    "maskable": 0.78,
    "apple": 0.76,
    "adaptive": 0.62,
    "round": 0.72,
}

BACKGROUND_COLOR = "#02307F"


# ---------------------------------------------------------------- helpers
def _resize_f01(channel: np.ndarray, size: int) -> np.ndarray:
    """Resize a float 0..1 channel with Lanczos, without 8-bit quantisation."""
    img = Image.fromarray(channel.astype(np.float32), "F")
    return np.clip(
        np.asarray(img.resize((size, size), Image.LANCZOS), dtype=np.float32), 0.0, 1.0
    )


def resize_rgba01(im: Image.Image, size: int) -> np.ndarray:
    """Premultiplied, float-accurate RGBA resize (avoids halos on soft edges)."""
    arr = np.asarray(im.convert("RGBA")).astype(np.float32) / 255.0
    alpha = arr[..., 3]
    rgb = arr[..., :3]
    pm = np.stack([_resize_f01(rgb[..., c] * alpha, size) for c in range(3)], axis=2)
    ar = _resize_f01(alpha, size)
    out = np.zeros((size, size, 4), dtype=np.float32)
    nz = ar > 1e-5
    out[nz, :3] = np.clip(pm[nz] / ar[nz][:, None], 0.0, 1.0)
    out[..., 3] = ar
    return out


def to_image(arr01: np.ndarray, alpha: bool) -> Image.Image:
    data = np.round(np.clip(arr01, 0.0, 1.0) * 255).astype(np.uint8)
    return Image.fromarray(data, "RGBA" if alpha else "RGB")


def circle_alpha(size: int, ss: int = 4) -> Image.Image:
    big = size * ss
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, big - 1, big - 1), fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def _poly_features(u: np.ndarray, v: np.ndarray, degree: int) -> np.ndarray:
    cols = [np.ones_like(u)]
    for d in range(1, degree + 1):
        for k in range(d + 1):
            cols.append(u ** (d - k) * v ** k)
    return np.stack(cols, axis=-1)


# ---------------------------------------------------------------- source
def load_artwork(src: str):
    """Cut the border-connected white background out of the source artwork."""
    a = np.asarray(Image.open(src).convert("RGB")).astype(np.float32)
    h, w, _ = a.shape
    r, g, b = a[..., 0], a[..., 1], a[..., 2]

    light = np.minimum(np.minimum(r, g), b) > 90.0
    labels, _ = ndimage.label(light)
    border = np.unique(
        np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]])
    )
    border = border[border != 0]
    white_bg = np.isin(labels, border)

    # alpha against the white backdrop, then decontaminate edge colours
    mn = a.min(axis=2)
    bg_alpha = np.clip((255.0 - mn) / 253.0, 0.0, 1.0)
    _, (iy, ix) = ndimage.distance_transform_edt(white_bg, return_indices=True)
    cut = np.zeros((h, w, 4), dtype=np.float32)
    cut[..., :3] = np.where(white_bg[..., None], a[iy, ix], a)
    cut[..., 3] = 255.0
    cut[white_bg, 3] = np.clip(bg_alpha[white_bg] * 255.0, 0.0, 255.0)

    dist_inside = ndimage.distance_transform_edt(~white_bg)
    return a, cut, white_bg, dist_inside


def fit_background(a: np.ndarray, white_bg: np.ndarray, dist_inside: np.ndarray):
    """Fit a smooth cubic in (u, v) to the artwork background.

    The fit is used twice: to build the clean gradient behind the logo, and to
    unmix the logo edges from the background (so there is no halo).
    """
    h, w, _ = a.shape
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mn = a.min(axis=2)
    yellow = (r > 120) & (g > 70) & (b < 170) & (r > b + 60)
    white_text = (mn > 100) & ~white_bg
    logo = ndimage.binary_dilation(yellow | white_text, iterations=8)
    background = (b > r + 35) & (b > g + 15) & (b > 50) & (dist_inside > 20) & ~logo

    u = np.broadcast_to(((np.arange(w) - w / 2) / (w / 2))[None, :], (h, w))
    v = np.broadcast_to(((np.arange(h) - h / 2) / (h / 2))[:, None], (h, w))
    feats = _poly_features(u, v, 3)
    x = feats[background]
    coef = np.zeros((x.shape[1], 3), dtype=np.float32)
    for c in range(3):
        coef[:, c], _, _, _ = np.linalg.lstsq(x, a[..., c][background], rcond=None)
    return coef


def extract_logo(a, cut, white_bg, dist_inside, coef) -> Image.Image:
    """Separate sun + wordmark from the background as a clean RGBA layer."""
    h, w, _ = a.shape
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mn = a.min(axis=2)
    yellow = (r > 120) & (g > 70) & (b < 170) & (r > b + 60)

    u = np.broadcast_to(((np.arange(w) - w / 2) / (w / 2))[None, :], (h, w))
    v = np.broadcast_to(((np.arange(h) - h / 2) / (h / 2))[:, None], (h, w))
    bg = np.clip(_poly_features(u, v, 3) @ coef, 0.0, 255.0)

    core = (yellow | ((mn > 150) & ~white_bg)) & ~white_bg
    core = ndimage.binary_erosion(core, iterations=1) | (yellow & ~white_bg)
    _, (cy, cx) = ndimage.distance_transform_edt(~core, return_indices=True)
    core_rgb = a[cy, cx]  # nearest solid logo colour (handles the sun shading)

    band = ndimage.binary_dilation(core, iterations=4) & ~core
    delta = a - bg
    span = core_rgb - bg
    denom = (span * span).sum(axis=2)
    proj = np.clip((delta * span).sum(axis=2) / np.maximum(denom, 1e-6), 0.0, 1.0)

    alpha = np.zeros((h, w), dtype=np.float32)
    alpha[core] = 1.0
    alpha[band] = proj[band]
    alpha[white_bg] = 0.0

    # decontaminate edge colours, then fall back to the nearest solid colour
    rgb = np.where(core[..., None], a, core_rgb)
    edge = band & (alpha > 0.02)
    dec = bg + delta / np.maximum(alpha, 0.02)[..., None]
    rgb[edge] = np.clip(dec[edge], 0.0, 255.0)
    rgb[alpha <= 0.004] = core_rgb[alpha <= 0.004]

    return to_image(np.dstack([np.clip(rgb, 0, 255) / 255.0, alpha]), alpha=True)


def gradient_profile(a: np.ndarray, white_bg: np.ndarray) -> np.ndarray:
    """Vertical brand gradient sampled from the artwork's own side edges.

    Sampling ~40px inside the left/right edges avoids the anti-aliased rim and
    gives the same ramp that the tile itself shows (bright top -> deep navy).
    """
    h, w, _ = a.shape
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    blueish = (b > r + 40) & (b > g + 20) & (b > 60)

    profile = np.full((h, 3), np.nan, dtype=np.float32)
    for y in range(h):
        xs = np.where(blueish[y])[0]
        if len(xs) < 120 or y < 55 or y > h - 55:
            continue
        left = a[y, min(xs.min() + 40, w - 1)]
        right = a[y, max(xs.max() - 40, 0)]
        profile[y] = (left + right) / 2.0

    idx = np.arange(h)
    for c in range(3):
        col = profile[:, c]
        good = ~np.isnan(col)
        col[~good] = np.interp(idx[~good], idx[good], col[good])
        col[:] = np.convolve(np.pad(col, 15, mode="edge"), np.ones(31) / 31, mode="valid")
        profile[:, c] = col
    return np.clip(profile / 255.0, 0.0, 1.0)


def gradient_canvas(profile: np.ndarray, size: int) -> np.ndarray:
    ys = np.linspace(0.0, 1.0, size, dtype=np.float32)
    pos = ys * (len(profile) - 1)
    lo = np.floor(pos).astype(int)
    hi = np.minimum(lo + 1, len(profile) - 1)
    frac = (pos - lo)[:, None]
    rows = profile[lo] * (1.0 - frac) + profile[hi] * frac
    return np.repeat(rows[:, None, :], size, axis=1)


def compose_logo(logo: Image.Image, profile: np.ndarray, size: int, scale: float):
    """Centre the logo on a full-bleed vertical gradient."""
    bg = gradient_canvas(profile, size)
    n = round(size * scale)
    off = (size - n) // 2
    art = resize_rgba01(logo, n)
    a = art[..., 3:4]
    bg[off:off + n, off:off + n] = art[..., :3] * a + bg[off:off + n, off:off + n] * (1.0 - a)
    return bg


# ---------------------------------------------------------------- build
def build(src: str, root: str) -> list[str]:
    a, cut, white_bg, dist_inside = load_artwork(src)
    coef = fit_background(a, white_bg, dist_inside)
    profile = gradient_profile(a, white_bg)
    logo = extract_logo(a, cut, white_bg, dist_inside, coef)
    tile = to_image(cut / 255.0, alpha=True)

    written: list[str] = []

    def save(im: Image.Image, path: str) -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        im.save(path, "PNG", optimize=True)
        written.append(path)

    res = os.path.join(root, "android/app/src/main/res")
    public = os.path.join(root, "public")
    icons = os.path.join(public, "icons")

    # ---- Android legacy + adaptive foreground
    for density, size in DENSITIES.items():
        folder = os.path.join(res, f"mipmap-{density}")
        save(to_image(resize_rgba01(tile, size), alpha=True),
             os.path.join(folder, "ic_launcher.png"))

        round_rgb = compose_logo(logo, profile, size, LOGO_SCALE["round"])
        round_img = to_image(round_rgb, alpha=False).convert("RGBA")
        round_img.putalpha(circle_alpha(size))
        save(round_img, os.path.join(folder, "ic_launcher_round.png"))

        fg = resize_rgba01(logo, round(FOREGROUND[density] * LOGO_SCALE["adaptive"]))
        canvas = np.zeros((FOREGROUND[density], FOREGROUND[density], 4), dtype=np.float32)
        off = (FOREGROUND[density] - fg.shape[0]) // 2
        canvas[off:off + fg.shape[0], off:off + fg.shape[0]] = fg
        save(to_image(canvas, alpha=True),
             os.path.join(folder, "ic_launcher_foreground.png"))

    # ---- PWA
    for size, names in ((192, ("icon-192.png", "icon-192x192.png")),
                        (512, ("icon-512.png", "icon-512x512.png"))):
        for name in names:
            save(to_image(resize_rgba01(tile, size), alpha=True), os.path.join(icons, name))
    for size in (192, 512):
        save(to_image(compose_logo(logo, profile, size, LOGO_SCALE["maskable"]), alpha=False),
             os.path.join(icons, f"maskable-{size}.png"))
    save(to_image(compose_logo(logo, profile, 180, LOGO_SCALE["apple"]), alpha=False),
         os.path.join(public, "apple-touch-icon.png"))

    # ---- favicon
    ico = to_image(resize_rgba01(tile, 64), alpha=True)
    ico_path = os.path.join(root, "app/favicon.ico")
    os.makedirs(os.path.dirname(ico_path), exist_ok=True)
    ico.save(ico_path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])
    written.append(ico_path)

    return written


def main() -> int:
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    parser = argparse.ArgumentParser(description="Generate Daily Pilot app icons")
    parser.add_argument("--src", default=None, help="source artwork (PNG)")
    parser.add_argument("--root", default=repo, help="project root to write into")
    args = parser.parse_args()

    default_src = os.path.join(repo, "assets/brand/rouzsaz.png")
    src = args.src or (default_src if os.path.isfile(default_src)
                       else os.path.expanduser("~/Desktop/rouzsaz.png"))
    if not os.path.isfile(src):
        parser.error(f"source artwork not found: {src}")

    print(f"source: {src}")
    written = build(src, args.root)
    for path in written:
        im = Image.open(path)
        alpha = im.getchannel("A").getextrema() if im.mode in ("RGBA", "LA") else None
        print(f"  {im.size[0]:>4}x{im.size[1]:<4} {im.mode:>5} alpha={alpha} "
              f"{os.path.relpath(path, args.root)}")
    print(f"{len(written)} files written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
