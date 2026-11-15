# AI-assisted code (Claude, Codex); see README, Use of AI.
"""Two extra slide figures from the scene packages: Rockadooie change with the two check windows, and Timure before/after radar."""
import json, math, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

S = Path(sys.argv[1]); OUT = Path(sys.argv[2])
def font(n, bold=True):
    try: return ImageFont.truetype("arialbd.ttf" if bold else "arial.ttf", n)
    except OSError: return ImageFont.load_default()
def merc(lat, lon): return lon, math.degrees(math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))
class Frame:
    def __init__(s, b, size):
        (a, w), (n, e) = b; s.x0, s.y0 = merc(a, w); s.x1, s.y1 = merc(n, e); s.w, s.h = size
    def px(s, lon, lat):
        x, y = merc(lat, lon); return ((x - s.x0) / (s.x1 - s.x0) * s.w, (s.y1 - y) / (s.y1 - s.y0) * s.h)
def rings(g): return g["coordinates"] if g["type"] == "Polygon" else [r for p in g["coordinates"] for r in p]
def load(p): return json.loads(Path(p).read_text(encoding="utf-8"))

# Rockadooie: relative HH change, official boundary, two 2 km check windows
d = S / "nsw_rockadooie_burn"; sc = load(d / "scene.json")
rel = sc["images"].get("change_rel") or sc["images"]["change"]
im = Image.open(d / rel["hh"]["event"]).convert("RGBA"); im = im.resize((im.width * 2, im.height * 2), Image.NEAREST)
im = Image.alpha_composite(Image.new("RGBA", im.size, "white"), im); fr = Frame(sc["bounds"], im.size); dr = ImageDraw.Draw(im)
for f in load(d / "official_final_boundary.geojson")["features"]:
    for r in rings(f["geometry"]):
        p = [fr.px(*c) for c in r]; dr.line(p + [p[0]], fill=(0, 0, 0, 255), width=4)
for f in load(d / "windows.geojson")["features"]:
    for r in rings(f["geometry"]):
        p = [fr.px(*c) for c in r]; dr.line(p + [p[0]], fill=(18, 48, 107, 255), width=6)
        x, y = min(q[0] for q in p), min(q[1] for q in p)
        lab = "Inside window" if f["properties"]["window"] == "inside" else "Outside window (control)"
        dr.rectangle([x, y - 40, x + dr.textlength(lab, font=font(28)) + 12, y - 4], fill=(18, 48, 107, 255))
        dr.text((x + 6, y - 38), lab, fill="white", font=font(28))
im.convert("RGB").save(OUT / "rockadooie_windows.jpg", quality=88)

# Timure: radar before and after the landslide, with the Copernicus mapped impact
d = S / "nepal_timure_landslide"; sc = load(d / "scene.json")
ser = {x["date"]: x for x in sc["series"]["dates"]}
ev = load(d / "ems_observed_event.geojson")["features"]
panels = []
for date, lab in (("2026-08-19", "19 Aug 2026, before"), ("2026-08-31", "31 Aug 2026, after")):
    p = Image.open(d / ser[date]["images"]["hh"]).convert("RGBA")
    p = Image.alpha_composite(Image.new("RGBA", p.size, "white"), p); fr = Frame(sc["bounds"], p.size); dd = ImageDraw.Draw(p)
    for f in ev:
        for r in rings(f["geometry"]):
            q = [fr.px(*c) for c in r]; dd.line(q + [q[0]], fill=(230, 60, 30, 255), width=4)
    head = Image.new("RGB", (p.width, 44), "white"); ImageDraw.Draw(head).text((p.width / 2, 22), lab, fill=(18, 48, 107), font=font(30), anchor="mm")
    col = Image.new("RGB", (p.width, p.height + 44), "white"); col.paste(head, (0, 0)); col.paste(p.convert("RGB"), (0, 44)); panels.append(col)
gap = 16; out = Image.new("RGB", (panels[0].width * 2 + gap, panels[0].height), "white")
out.paste(panels[0], (0, 0)); out.paste(panels[1], (panels[0].width + gap, 0))
out.save(OUT / "timure_before_after.jpg", quality=88)
print("ok", out.size)
