# AI-assisted code (Claude, Codex); see README, Use of AI.
"""Slide figure: 1 ha cells passing a radar rule and an optical rule, in the two Rockadooie check windows."""
import json, math, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

d = Path(sys.argv[1]); out = Path(sys.argv[2])
def load(p): return json.loads(Path(p).read_text(encoding="utf-8"))
def merc(lat, lon): return lon, math.degrees(math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)))
sc = load(d / "scene.json"); cells = load(d / "cells.geojson")["features"]; wins = load(d / "windows.geojson")["features"]
bnd = load(d / "official_final_boundary.geojson")["features"]
rel = sc["images"].get("change_rel") or sc["images"]["change"]
base = Image.open(d / rel["hh"]["event"]).convert("RGBA")
(s0, w0), (n0, e0) = sc["bounds"]; X0, Y0 = merc(s0, w0); X1, Y1 = merc(n0, e0)
def px(lon, lat, W, H):
    x, y = merc(lat, lon); return ((x - X0) / (X1 - X0) * W, (Y1 - y) / (Y1 - Y0) * H)
xs = [c[0] for f in wins for c in f["geometry"]["coordinates"][0]]; ys = [c[1] for f in wins for c in f["geometry"]["coordinates"][0]]
pad = 0.006
crop_ll = (min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)
scale = 3
big = base.resize((base.width * scale, base.height * scale), Image.NEAREST)
big = Image.alpha_composite(Image.new("RGBA", big.size, "white"), big)
# fade the background so the passing cells stand out
big = Image.blend(big, Image.new("RGBA", big.size, "white"), 0.55)
W, H = big.size
L, T = px(crop_ll[0], crop_ll[3], W, H); R, B = px(crop_ll[2], crop_ll[1], W, H)
try: ft, fs = ImageFont.truetype("arialbd.ttf", 30), ImageFont.truetype("arial.ttf", 24)
except OSError: ft = fs = ImageFont.load_default()
panels = []
for title, key, thr, col in (("Radar: HH brighter by at least 3 dB", "hh_event_db", 3.0, (230, 97, 1)),
                             ("Optical: dNBR at least 0.10", "dnbr", 0.10, (127, 39, 4))):
    im = big.copy(); dr = ImageDraw.Draw(im)
    for f in bnd:
        rings = f["geometry"]["coordinates"] if f["geometry"]["type"] == "Polygon" else [r for p in f["geometry"]["coordinates"] for r in p]
        for r in rings:
            p = [px(*c, W, H) for c in r]
            for i in range(0, len(p) - 1, 2): dr.line([p[i], p[i + 1]], fill=(179, 84, 30, 255), width=4)
    counts = {}
    for f in cells:
        pr = f["properties"]; v = pr.get(key)
        ok = pr["valid"] and v is not None and v >= thr
        counts.setdefault(pr["window"], [0, 0]); counts[pr["window"]][1] += pr["valid"]; counts[pr["window"]][0] += ok
        if ok or not pr["valid"]:
            dr.polygon([px(*c, W, H) for c in f["geometry"]["coordinates"][0]], fill=col + (255,) if ok else (170, 170, 170, 255))
    for f in wins:
        p = [px(*c, W, H) for c in f["geometry"]["coordinates"][0]]; dr.line(p + [p[0]], fill=(18, 48, 107, 255), width=5)
    im = im.crop((int(L), int(T), int(R), int(B))).convert("RGB")
    head = Image.new("RGB", (im.width, 84), "white"); hd = ImageDraw.Draw(head)
    hd.text((10, 6), title, fill=(18, 48, 107), font=ft)
    hd.text((10, 46), f"outside (left): {counts['west'][0]} of {counts['west'][1]} cells   ·   inside (right): {counts['inside'][0]} of {counts['inside'][1]} cells", fill=(27, 35, 48), font=fs)
    col_im = Image.new("RGB", (im.width, im.height + 84), "white"); col_im.paste(head, (0, 0)); col_im.paste(im, (0, 84)); panels.append(col_im)
    print(title, counts)
gap = 20
fig = Image.new("RGB", (panels[0].width, panels[0].height * 2 + gap), "white")
fig.paste(panels[0], (0, 0)); fig.paste(panels[1], (0, panels[0].height + gap))
fig.save(out, quality=90); print(fig.size)
