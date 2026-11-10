#!/usr/bin/env python3
"""Builds every SALURA logo asset from the geometry below.

Masters go to docs/brand/, web and PWA icons to apps/web/public/.
Run from the repo root:  python3 docs/brand/build_logo.py
Needs: pip install cairosvg fonttools brotli pillow
"""

import io
import json
from pathlib import Path

import cairosvg
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "docs/brand"
PUBLIC = ROOT / "apps/web/public"
FONT = next(ROOT.glob("node_modules/.pnpm/@fontsource-variable+plus-jakarta-sans@*/node_modules/@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2"))

GREEN = "#17603A"  # --primary
GREEN_STRONG = "#0E3F25"  # --primary-strong
INK = "#111813"  # --ink
WHITE = "#FFFFFF"

# --- The mark: "Nota-chat". A receipt with a torn top edge whose bottom-left corner becomes a chat tail.
# 256 grid. Body x 56..200, teeth on top, 38 px corner radius bottom-right, two text lines cut out.
# Bounding box x 56..200, y 30..222; centre (128, 126).
MARK = (
    "M56,50 L80,30 L104,50 L128,30 L152,50 L176,30 L200,50 V156 A38,38 0 0 1 162,194 H98 L56,222 Z "
    "M96,86 H160 A8,8 0 0 1 160,102 H96 A8,8 0 0 1 96,86 Z "
    "M96,120 H136 A8,8 0 0 1 136,136 H96 A8,8 0 0 1 96,120 Z"
)
# Small-size cut (favicon, in-app logo up to ~48 px): two bigger teeth, thicker lines, wider gaps.
MARK_SMALL = (
    "M56,58 L92,30 L128,58 L164,30 L200,58 V154 A40,40 0 0 1 160,194 H100 L56,222 Z "
    "M99,88 H157 A11,11 0 0 1 157,110 H99 A11,11 0 0 1 99,88 Z "
    "M99,130 H129 A11,11 0 0 1 129,152 H99 A11,11 0 0 1 99,130 Z"
)
BBOX_CX, BBOX_CY, BBOX_H = 128, 126, 192


def mark(d, fill, transform=""):
    t = f' transform="{transform}"' if transform else ""
    return f'<path fill="{fill}" fill-rule="evenodd"{t} d="{d}"/>'


def svg(w, h, body, title="SALURA"):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="{title}">'
        f"<title>{title}</title>{body}</svg>\n"
    )


def placed(d, fill, size, height_ratio, dy=0.0):
    """The mark centred in a size×size square, its height = height_ratio × size."""
    s = size * height_ratio / BBOX_H
    return mark(d, fill, f"translate({size / 2:g} {size / 2 + dy * size:g}) scale({s:.4f}) translate({-BBOX_CX} {-BBOX_CY})")


def tile(size, d, ratio, radius, bg=GREEN, fg=WHITE):
    rect = f'<rect width="{size}" height="{size}" rx="{radius}" fill="{bg}"/>'
    return svg(size, size, rect + placed(d, fg, size, ratio, dy=-0.01))


# --- Wordmark: "SALURA" in Plus Jakarta Sans Bold, converted to outlines (no font needed to display it).
def wordmark_paths(cap_height, tracking=0.02):
    font = instantiateVariableFont(TTFont(FONT), {"wght": 700})
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    upm = font["head"].unitsPerEm
    caps = font["OS/2"].sCapHeight
    s = cap_height / caps
    x, parts = 0.0, []
    for ch in "SALURA":
        name = cmap[ord(ch)]
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(TransformPen(pen, (s, 0, 0, -s, x, cap_height)))
        parts.append(pen.getCommands())
        x += glyphs[name].width * s + tracking * upm * s
    width = x - tracking * upm * s
    return " ".join(parts), width


def lockups():
    cap = 104  # ≈ 54 % of the mark's height
    word, ww = wordmark_paths(cap)
    gap = 52
    # Horizontal: mark (x 56..200) then wordmark; caps centred on the receipt body (y 30..194 → 112).
    wx = 200 + gap
    wy = 112 - cap / 2
    w = round(wx + ww + 24)
    for name, mfill, wfill in (("horizontal", GREEN, INK), ("horizontal-white", WHITE, WHITE), ("horizontal-black", "#000", "#000")):
        body = mark(MARK, mfill, "translate(-32 0)") + f'<path fill="{wfill}" transform="translate({wx - 32:g} {wy:g})" d="{word}"/>'
        (BRAND / f"salura-{name}.svg").write_text(svg(w - 32, 256, body))
    # Stacked: mark on top, wordmark centred under it.
    sw = max(ww, 192) + 48
    cx = sw / 2
    for name, mfill, wfill in (("stacked", GREEN, INK), ("stacked-white", WHITE, WHITE)):
        body = mark(MARK, mfill, f"translate({cx - 128:g} -6)") + f'<path fill="{wfill}" transform="translate({cx - ww / 2:g} 252)" d="{word}"/>'
        (BRAND / f"salura-stacked{name[7:]}.svg").write_text(svg(round(sw), 252 + cap + 24, body))


def png(svg_text, size):
    return Image.open(io.BytesIO(cairosvg.svg2png(bytestring=svg_text.encode(), output_width=size, output_height=size))).convert("RGBA")


def main():
    BRAND.mkdir(parents=True, exist_ok=True)
    # Symbol masters.
    for name, d, fill in (
        ("symbol", MARK, GREEN),
        ("symbol-black", MARK, "#000"),
        ("symbol-white", MARK, WHITE),
        ("symbol-small", MARK_SMALL, GREEN),
    ):
        (BRAND / f"salura-{name}.svg").write_text(svg(256, 256, mark(d, fill)))
    (BRAND / "salura-app-icon.svg").write_text(tile(512, MARK, 0.48, 112))
    lockups()

    # Web + PWA icons.
    fav = tile(64, MARK_SMALL, 0.60, 16)
    (PUBLIC / "favicon.svg").write_text(fav)
    ico = [png(tile(n, MARK_SMALL, 0.64, round(n * 0.2)), n) for n in (16, 32, 48)]
    ico[-1].save(PUBLIC / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)], append_images=ico[:-1])
    icons = PUBLIC / "icons"
    icons.mkdir(exist_ok=True)
    png(tile(512, MARK, 0.48, 112), 192).save(icons / "icon-192.png")
    png(tile(512, MARK, 0.48, 112), 512).save(icons / "icon-512.png")
    # Maskable: full-bleed, mark inside the 80 % safe circle.
    png(tile(512, MARK, 0.40, 0), 512).save(icons / "icon-maskable-512.png")
    png(tile(512, MARK, 0.40, 0), 192).save(icons / "icon-maskable-192.png")
    # iOS rounds the corners itself and shows transparency as black: full-bleed, opaque.
    png(tile(180, MARK, 0.46, 0), 180).convert("RGB").save(PUBLIC / "apple-touch-icon.png")

    manifest = {
        "name": "SALURA — Konsol Distributor",
        "short_name": "SALURA",
        "description": "Agen AI yang mengubah pesanan WhatsApp warung menjadi pesanan tervalidasi untuk distributor FMCG.",
        "lang": "id",
        "id": "/",
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "orientation": "any",
        "background_color": "#F2F4F1",
        "theme_color": GREEN,
        "categories": ["business", "productivity"],
        "icons": [
            {"src": "/icons/icon-192.png?v=2", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "/icons/icon-512.png?v=2", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": "/icons/icon-maskable-192.png?v=2", "sizes": "192x192", "type": "image/png", "purpose": "maskable"},
            {"src": "/icons/icon-maskable-512.png?v=2", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }
    (PUBLIC / "manifest.webmanifest").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

    # The in-app <Logo /> paths, so the React component can be checked against this file.
    print("MARK_SMALL =", MARK_SMALL)
    print("done")


if __name__ == "__main__":
    main()
