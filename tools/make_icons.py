"""Draw the Due app icon (design-spec section 7) and export every size the site needs.

A calendar page with one day filled in: solid background, binder bar, 4x3 grid of outlined cells,
one cell filled with the accent. No gradient, gloss, shadow, text or rounded corners.

Run:  python tools/make_icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "icons"

BG = "#F2F1EC"
INK = "#1C1C1A"
ACCENT = "#0F6B7A"
MASTER = 1024


def draw_mark(scale=1.0, stroke=20):
    """Draw the full 1024px icon; scale < 1 shrinks the mark around the center (maskable safe zone)."""
    img = Image.new("RGB", (MASTER, MASTER), BG)
    d = ImageDraw.Draw(img)
    c = MASTER / 2

    def box(x0, y0, x1, y1):
        return [round(c + (x0 - c) * scale), round(c + (y0 - c) * scale),
                round(c + (x1 - c) * scale) - 1, round(c + (y1 - c) * scale) - 1]

    # binder bar
    d.rectangle(box(128, 178, 896, 234), fill=INK)
    # 4 columns x 3 rows of 168px cells with 32px gaps, x 128-896, y 278-846
    width = max(1, round(stroke * scale))
    for row in range(3):
        for col in range(4):
            x0, y0 = 128 + col * 200, 278 + row * 200
            rect = box(x0, y0, x0 + 168, y0 + 168)
            if (row, col) == (1, 2):  # row 2, column 3: x 528-696, y 478-646
                d.rectangle(rect, fill=ACCENT)
            else:
                d.rectangle(rect, outline=INK, width=width)
    return img


def save(img, size, name):
    out = img.resize((size, size), Image.LANCZOS)
    out.save(OUT / name, "PNG", optimize=True)
    print(f"wrote {OUT / name} ({size}x{size})")
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    full = draw_mark()
    save(full, 180, "apple-touch-icon.png")
    save(full, 192, "icon-192.png")
    save(full, 512, "icon-512.png")
    save(draw_mark(scale=0.72), 512, "icon-maskable-512.png")

    # Favicons: same drawing with heavier outlines so the grid survives at 16-32px.
    fav = draw_mark(stroke=44)
    save(fav, 32, "favicon-32.png")
    fav.resize((48, 48), Image.LANCZOS).save(OUT / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    print(f"wrote {OUT / 'favicon.ico'}")


if __name__ == "__main__":
    main()
