# AI-assisted code (Claude, Codex); see README, Use of AI.
"""Slide figure: the same 1 ha cells seen by radar (HH change) and by optical images (dNBR), inside the burn and outside.

Usage: python make_fire_compare.py <cells.geojson> <out.jpg>
"""
import json
import sys
from PIL import Image, ImageDraw, ImageFont


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def radar_col(v):
    if v is None:
        return (154, 154, 154)
    t = max(-1, min(1, v / 6))
    return mix((247, 247, 247), (178, 24, 43), t) if t >= 0 else mix((247, 247, 247), (33, 102, 172), -t)


def dnbr_col(v):
    if v is None:
        return (154, 154, 154)
    return mix((255, 245, 235), (127, 39, 4), max(0, min(1, v / 0.4)))


def main(src, out):
    feats = json.load(open(src, encoding="utf-8"))["features"]
    try:
        f_t, f_s = ImageFont.truetype("arialbd.ttf", 22), ImageFont.truetype("arial.ttf", 17)
    except OSError:
        f_t = f_s = ImageFont.load_default()
    panel, gap, head, side = 300, 18, 34, 150
    W, H = side + 2 * panel + gap + 10, 2 * (panel + head) + gap + 40
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    rows = [("Radar: HH change", "hh_event_db", radar_col, "24 Jul to 17 Aug, -6 to +6 dB"),
            ("Optical: dNBR", "dnbr", dnbr_col, "27 Jul to 16 Aug, 0 to 0.4")]
    for ci, win in enumerate(("inside", "west")):
        cells = [f for f in feats if f["properties"]["window"] == win]
        xs = [c[0] for f in cells for c in f["geometry"]["coordinates"][0]]
        ys = [c[1] for f in cells for c in f["geometry"]["coordinates"][0]]
        x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
        ox = side + ci * (panel + gap)
        d.text((ox + panel / 2, 6), "Inside the burn" if win == "inside" else "Outside, to the west", fill=(18, 48, 107), font=f_t, anchor="mt")
        for ri, (_, key, col, _) in enumerate(rows):
            oy = head + ri * (panel + head + gap)
            for f in cells:
                pts = [(ox + (x - x0) / (x1 - x0) * panel, oy + (y1 - y) / (y1 - y0) * panel) for x, y in f["geometry"]["coordinates"][0]]
                v = f["properties"][key] if f["properties"]["valid"] else None
                d.polygon(pts, fill=col(v), outline=(255, 255, 255))
            d.rectangle([ox, oy, ox + panel, oy + panel], outline=(120, 130, 145), width=2)
    for ri, (name, _, _, rng) in enumerate(rows):
        oy = head + ri * (panel + head + gap)
        d.text((8, oy + panel / 2 - 20), name.split(":")[0] + ":", fill=(18, 48, 107), font=f_t)
        d.text((8, oy + panel / 2 + 6), name.split(": ")[1], fill=(27, 35, 48), font=f_s)
        d.text((8, oy + panel / 2 + 28), rng, fill=(91, 102, 118), font=ImageFont.truetype("arial.ttf", 13) if f_s != ImageFont.load_default() else f_s)
    d.text((W / 2, H - 22), "Each square is one 1 ha cell. Grey: no data.", fill=(91, 102, 118), font=f_s, anchor="mm")
    im.save(out, quality=90)
    print(im.size)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
