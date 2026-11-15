# AI-assisted code (Claude, Codex); see README, Use of AI.
"""
Static figures for the 7-slide demo, drawn from the same scene packages the web page uses.
No new analysis: cells, outlines and images are read from docs/scenes.

Usage:
  uv run --no-project --with pillow python make_slide_figures.py --scenes ../docs/scenes --out ../docs/slides/img
"""

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BLUE, RED, ORANGE, NAVY = (94, 60, 153, 210), (178, 24, 43, 210), (245, 166, 35, 255), (18, 48, 107, 255)


def merc(lat, lon):
    return lon, math.degrees(math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))


class Frame:
    """Maps lon/lat to pixels of an image covering Leaflet bounds [[s, w], [n, e]] in Web Mercator."""

    def __init__(self, bounds, size):
        (s, w), (n, e) = bounds
        self.x0, self.y0 = merc(s, w)
        self.x1, self.y1 = merc(n, e)
        self.w, self.h = size

    def px(self, lon, lat):
        x, y = merc(lat, lon)
        return ((x - self.x0) / (self.x1 - self.x0) * self.w, (self.y1 - y) / (self.y1 - self.y0) * self.h)


def rings(geom):
    if geom["type"] == "Polygon":
        return geom["coordinates"]
    if geom["type"] == "MultiPolygon":
        return [r for poly in geom["coordinates"] for r in poly]
    return []


def font(size):
    for name in ("segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def load(p):
    return json.loads(Path(p).read_text(encoding="utf-8"))


def scale_to(im, width):
    return im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)


def sale(scenes, out):
    d = scenes / "vic_sale_common"
    scene = load(d / "scene.json")
    opt = next(l for l in scene["layers"] if l["id"] == "optical")
    base = scale_to(Image.open(d / opt["file"]).convert("RGBA"), 1200)
    fr = Frame(opt["bounds"], base.size)
    over = Image.new("RGBA", base.size, (0, 0, 0, 0))
    dr = ImageDraw.Draw(over)
    n = 0
    for f in load(d / "sale_cells.geojson")["features"]:
        p = f["properties"]
        if p["valid_common"] and p["hv_1"] is not None and p["hv_1"] <= -3:
            n += 1
            for ring in rings(f["geometry"]):
                dr.polygon([fr.px(*c) for c in ring], fill=BLUE)
    Image.alpha_composite(base, over).convert("RGB").save(out / "sale_candidates.jpg", quality=88)
    print("sale cells drawn:", n)


def burdekin(scenes, out):
    d = scenes / "qld_burdekin_fields"
    scene = load(d / "scene.json")
    opt = next(l for l in scene["layers"] if l["id"] == "optical")
    base = scale_to(Image.open(d / opt["file"]).convert("RGBA"), 1000)
    fr = Frame(opt["bounds"], base.size)
    dr = ImageDraw.Draw(base)
    f30 = font(30)
    for f in load(d / "fields.geojson")["features"]:
        for ring in rings(f["geometry"]):
            pts = [fr.px(*c) for c in ring]
            dr.line(pts + [pts[0]], fill=ORANGE, width=5)
            x, y = min(p[0] for p in pts), min(p[1] for p in pts)
            dr.text((x, y - 36), f["properties"]["id"], fill=(255, 255, 255), font=f30, stroke_width=3, stroke_fill=(0, 0, 0))
    base.convert("RGB").save(out / "burdekin_fields.jpg", quality=88)


def rockadooie(scenes, out):
    """Whole-burn HH change across the burn, with the official final boundary."""
    d = scenes / "nsw_rockadooie_burn"
    scene = load(d / "scene.json")
    # Relative to the whole window, so the change shared by the surroundings does not hide the burn.
    rel = scene["images"].get("change_rel") or scene["images"]["change"]
    change = Image.open(d / rel["hh"]["event"]).convert("RGBA")
    change = change.resize((change.width * 2, change.height * 2), Image.NEAREST)
    im = Image.alpha_composite(Image.new("RGBA", change.size, (255, 255, 255, 255)), change)
    fr = Frame(scene["bounds"], im.size)
    dr = ImageDraw.Draw(im)
    for f in load(d / "official_final_boundary.geojson")["features"]:
        for ring in rings(f["geometry"]):
            pts = [fr.px(*c) for c in ring]
            dr.line(pts + [pts[0]], fill=(0, 0, 0, 255), width=4)
    im.convert("RGB").save(out / "rockadooie_change.jpg", quality=88)


def rockadooie_cells(scenes, out):
    d = scenes / "nsw_rockadooie_burn"
    cells = load(d / "cells.geojson")["features"]
    boundary = load(d / "official_final_boundary.geojson")["features"]
    lats, lons = [], []
    for f in cells + boundary:
        for ring in rings(f["geometry"]):
            for lon, lat in ring:
                lons.append(lon)
                lats.append(lat)
    pad = 0.004
    bounds = [[min(lats) - pad, min(lons) - pad], [max(lats) + pad, max(lons) + pad]]
    x0, y0 = merc(*bounds[0])
    x1, y1 = merc(*bounds[1])
    w = 1200
    h = round(w * (y1 - y0) / (x1 - x0))
    im = Image.new("RGBA", (w, h), (238, 242, 236, 255))
    fr = Frame(bounds, (w, h))
    dr = ImageDraw.Draw(im)
    for f in cells:
        p = f["properties"]
        if not p["valid"]:
            fill = (154, 154, 154, 255)
        elif p["hh_event_db"] is not None and p["hh_event_db"] >= 3:
            fill = RED[:3] + (255,)
        else:
            fill = (255, 255, 255, 255)
        for ring in rings(f["geometry"]):
            dr.polygon([fr.px(*c) for c in ring], fill=fill, outline=(220, 220, 220, 255))
    for f in boundary:
        for ring in rings(f["geometry"]):
            pts = [fr.px(*c) for c in ring]
            for i in range(0, len(pts) - 1, 2):   # dashed outline
                dr.line([pts[i], pts[i + 1]], fill=(179, 84, 30, 255), width=4)
    im.convert("RGB").save(out / "rockadooie_cells.jpg", quality=88)


def timure(scenes, out):
    d = scenes / "nepal_timure_landslide"
    scene = load(d / "scene.json")
    change = Image.open(d / scene["images"]["change"]["hv"]["normal"]).convert("RGBA")
    change = change.resize((change.width * 8, change.height * 8), Image.NEAREST)
    base = Image.new("RGBA", change.size, (255, 255, 255, 255))
    im = Image.alpha_composite(base, change)
    fr = Frame(scene["bounds"], im.size)
    dr = ImageDraw.Draw(im)
    for f in load(d / "ems_observed_event.geojson")["features"]:
        for ring in rings(f["geometry"]):
            pts = [fr.px(*c) for c in ring]
            dr.line(pts + [pts[0]], fill=(0, 0, 0, 255), width=4)
    im.convert("RGB").save(out / "timure_change.jpg", quality=88)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenes", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    scenes, out = Path(a.scenes), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    sale(scenes, out)
    burdekin(scenes, out)
    rockadooie(scenes, out)
    timure(scenes, out)
