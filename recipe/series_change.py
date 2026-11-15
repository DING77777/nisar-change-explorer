# AI-assisted code (Claude, Codex); see README, Use of AI.
"""Change maps between consecutive dates of a case's series, for step-by-step playback. Adds 'series_change' to scene.json.

Usage: python series_change.py <config.json> --data-root <data-root> --out <scenes folder>
"""
import argparse, json
from pathlib import Path
import numpy as np
from make_scene import read_db, WebGrid, save_png, change_palette, CHANGE_LIMIT_DB, POLS

ap = argparse.ArgumentParser(); ap.add_argument("config"); ap.add_argument("--data-root", required=True); ap.add_argument("--out", required=True)
a = ap.parse_args()
cfg = json.loads(Path(a.config).read_text(encoding="utf-8-sig"))
dates = sorted(cfg["series"], key=lambda d: d["date"])
db, valid, tr, crs = read_db(dates, a.data_root, cfg["bbox"], int(cfg.get("looks", 5)), cfg.get("mode", "sliding"), cfg.get("stack"))
grid = WebGrid(valid.shape, tr, crs)
sd = Path(a.out) / cfg["id"]; (sd / "series_change").mkdir(exist_ok=True)
items = []
for i in range(1, len(dates)):
    d0, d1 = dates[i - 1]["date"], dates[i]["date"]
    imgs = {}
    for j, p in enumerate(POLS):
        name = f"series_change/{p}_{d0.replace('-', '')}_{d1.replace('-', '')}.png"
        save_png(sd / name, grid.warp(db[i][j] - db[i - 1][j]), -CHANGE_LIMIT_DB, CHANGE_LIMIT_DB, change_palette())
        imgs[p] = name
    items.append({"from": d0, "to": d1, "images": imgs})
scene = json.loads((sd / "scene.json").read_text(encoding="utf-8"))
scene["series_change"] = items
(sd / "scene.json").write_text(json.dumps(scene, indent=1), encoding="utf-8")
print(len(items), "periods")
