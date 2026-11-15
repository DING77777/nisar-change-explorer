# AI-assisted code (Claude, Codex); see README, Use of AI.
"""
Build one "scene package" for the NISAR Change Explorer web page.

Input : a scene config (JSON) naming three co-registered NISAR GCOV dates
        (two before an event, one after) as HHHH / HVHV GeoTIFFs in linear gamma0.
        Optional: "series", a longer list of dates for the time chart and date slider, and
        "zones", named boxes (for example a target, a control and stable ground) that get their own curves.
Output: <out>/<scene id>/scene.json plus PNG overlays, and an updated <out>/index.json.

The same steps run for every scene:
  1. read the area of interest, keep pixels valid in all dates and both polarisations
  2. average linear power in a looks x looks window, then convert to dB (10*log10)
  3. normal change = baseline_2 - baseline_1 ; event change = after - baseline_2
  4. summary statistics of both changes, and the median return on every date
  5. warp display copies to Web Mercator and save as PNG

No classification is made and no threshold decides what a change means.

Usage:
  uv run --with rasterio --with numpy --with pillow python make_scene.py CONFIG.json \
      --data-root <data-root> --out ../docs/scenes
"""

import argparse
import csv
import datetime as dt
import json
import shutil
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.transform import Affine, array_bounds
from rasterio.warp import calculate_default_transform, reproject, transform_bounds
from rasterio.windows import Window, from_bounds

WEB_CRS = "EPSG:3857"
STRETCH_DB = {"hh": (-25.0, 5.0), "hv": (-32.0, -5.0)}   # same display range on every date
CHANGE_LIMIT_DB = 6.0
ROLES = ["baseline_1", "baseline_2", "after"]
POLS = ["hh", "hv"]


# ------------------------------------------------------------------ reading
def to_crs_bounds(bbox, crs):
    w, s, e, n = bbox["bounds"]
    if bbox["crs"] != crs.to_string():
        w, s, e, n = transform_bounds(bbox["crs"], crs, w, s, e, n, densify_pts=21)
    return w, s, e, n


def aoi_window(src, bbox):
    """Pixel window of the config bbox ({"crs": ..., "bounds": [w, s, e, n]}, or "full") in the raster."""
    full = Window(0, 0, src.width, src.height)
    if bbox == "full":
        return full
    win = from_bounds(*to_crs_bounds(bbox, src.crs), src.transform).round_offsets().round_lengths()
    return win.intersection(full)


def box_sum(a, n):
    c = np.cumsum(np.cumsum(np.pad(a, ((1, 0), (1, 0))), axis=0, dtype=np.float64), axis=1)
    return c[n:, n:] - c[:-n, n:] - c[n:, :-n] + c[:-n, :-n]


def read_sliding(paths, bbox, looks, valid_paths=()):
    """Sliding looks x looks mean of linear power at native posting. Needs every pixel in the window valid.

    A pixel is valid when it is finite and positive in every raster, and equals 1 in every valid_paths raster
    (quality masks prepared upstream from the product's own mask layers).
    """
    pad = looks // 2
    with rasterio.open(paths[0]) as src:
        win = aoi_window(src, bbox)
        full = Window(0, 0, src.width, src.height)
        read = Window(win.col_off - pad, win.row_off - pad, win.width + 2 * pad, win.height + 2 * pad).intersection(full)
        crs = src.crs
        transform = src.window_transform(Window(read.col_off + pad, read.row_off + pad, 1, 1))
    stack = []
    for p in paths:
        with rasterio.open(p) as src:
            stack.append(src.read(1, window=read).astype(np.float32))
    valid = np.all([np.isfinite(a) & (a > 0) for a in stack], axis=0)
    for p in valid_paths:
        with rasterio.open(p) as src:
            valid &= src.read(1, window=read) == 1
    full_count = box_sum(valid.astype(np.float64), looks) > looks * looks - 0.5
    out = []
    for a in stack:
        mean = box_sum(np.where(valid, a, 0.0), looks) / (looks * looks)
        out.append(np.where(full_count, mean, np.nan).astype(np.float32))
    return out, transform, crs


def read_block(paths, bbox, looks, valid_paths=()):
    """Non-overlapping looks x looks block mean of linear power (for wide overviews).

    Strict: a block is kept only when every pixel in it is valid in every raster.
    """
    with rasterio.open(paths[0]) as src:
        win = aoi_window(src, bbox)
        win = Window(win.col_off, win.row_off, win.width // looks * looks, win.height // looks * looks)
        crs = src.crs
        transform = src.window_transform(win) * Affine.scale(looks)
    rows, cols = int(win.height // looks), int(win.width // looks)

    def blocks(a):
        return a.reshape(rows, looks, cols, looks)

    stack, keep = [], np.ones((rows, cols), bool)
    for p in paths:
        with rasterio.open(p) as src:
            a = src.read(1, window=win)
        good = np.isfinite(a) & (a > 0)
        keep &= blocks(good).all(axis=(1, 3))
        a[~good] = 0
        stack.append(blocks(a).mean(axis=(1, 3), dtype=np.float64).astype(np.float32))
        del a, good
    for p in valid_paths:
        with rasterio.open(p) as src:
            keep &= blocks(src.read(1, window=win) == 1).all(axis=(1, 3))
    return [np.where(keep, a, np.nan).astype(np.float32) for a in stack], transform, crs


def read_db_stack(dates, data_root, stack, bbox):
    """dB arrays from multi-band stacks that are ALREADY in dB (one band per date). Never logged again.

    stack = {"hh": path, "hv": path}; each date names its 1-based "band". Non-finite values are no data.
    """
    arrays = []
    for d in dates:
        for p in POLS:
            with rasterio.open(Path(data_root) / stack[p]) as src:
                win = aoi_window(src, bbox)
                arrays.append(src.read(int(d["band"]), window=win).astype(np.float32))
                transform, crs = src.window_transform(win), src.crs
    valid = np.all([np.isfinite(a) for a in arrays], axis=0)
    db = [[np.where(valid, arrays[i * 2 + j], np.nan) for j in range(len(POLS))] for i in range(len(dates))]
    return db, valid, transform, crs


def read_db(dates, data_root, bbox, looks, mode, stack=None):
    """dB arrays [date][pol] on pixels valid in every date and both polarisations."""
    if stack:
        return read_db_stack(dates, data_root, stack, bbox)
    paths = [str(Path(data_root) / d[p]) for d in dates for p in POLS]
    valid_paths = [str(Path(data_root) / d["valid"]) for d in dates if d.get("valid")]
    arrays, transform, crs = (read_block if mode == "block" else read_sliding)(paths, bbox, looks, valid_paths)
    valid = np.all([np.isfinite(a) for a in arrays], axis=0)
    db = [[np.where(valid, 10 * np.log10(np.where(valid, arrays[i * 2 + j], 1.0)), np.nan).astype(np.float32)
           for j in range(len(POLS))] for i in range(len(dates))]
    return db, valid, transform, crs


# ------------------------------------------------------------------ statistics
def summary(change):
    v = change[np.isfinite(change)]
    if v.size == 0:
        return None
    q25, q50, q75 = np.percentile(v, [25, 50, 75])
    return {"median_db": round(float(q50), 2), "q25_db": round(float(q25), 2), "q75_db": round(float(q75), 2),
            "share_above_3db": round(float((v > 3).mean()), 4), "share_below_minus_3db": round(float((v < -3).mean()), 4)}


def median_db(a):
    v = a[np.isfinite(a)]
    return round(float(np.median(v)), 2) if v.size else None


def zone_slices(zone, transform, crs, shape):
    """Array slices of a zone box, and its corners for the web map."""
    win = from_bounds(*to_crs_bounds(zone["bbox"], crs), transform).round_offsets().round_lengths()
    r0, r1 = max(0, int(win.row_off)), min(shape[0], int(win.row_off + win.height))
    c0, c1 = max(0, int(win.col_off)), min(shape[1], int(win.col_off + win.width))
    if r1 <= r0 or c1 <= c0:
        raise SystemExit(f"Zone '{zone['name']}' lies outside the scene bbox.")
    west, south, east, north = transform_bounds(
        crs, "EPSG:4326", *array_bounds(r1 - r0, c1 - c0, transform * Affine.translation(c0, r0)))
    return (slice(r0, r1), slice(c0, c1)), [[round(south, 6), round(west, 6)], [round(north, 6), round(east, 6)]]


# ------------------------------------------------------------------ display
def grey_palette():
    pal = [0, 0, 0]
    for i in range(255):
        g = round(i / 254 * 255)
        pal += [g, g, g]
    return pal


def change_palette():
    dark, mid, bright = (33, 102, 172), (247, 247, 247), (178, 24, 43)   # darker / no change / brighter
    pal = [0, 0, 0]
    for i in range(255):
        t = i / 254 * 2 - 1
        a, b, f = (mid, bright, t) if t >= 0 else (mid, dark, -t)
        pal += [round(a[k] + (b[k] - a[k]) * f) for k in range(3)]
    return pal


def save_png(path, values, lo, hi, palette):
    """Index 0 is transparent (no data); 1..255 span lo..hi."""
    scaled = np.clip((values - lo) / (hi - lo), 0, 1)
    idx = np.where(np.isfinite(values), 1 + np.round(np.nan_to_num(scaled) * 254), 0).astype(np.uint8)
    im = Image.fromarray(idx, mode="P")
    im.putpalette(palette)
    im.save(path, transparency=0, optimize=True)


class WebGrid:
    """One Web Mercator grid shared by every layer of a scene."""

    def __init__(self, shape, transform, crs):
        h, w = shape
        self.src_transform, self.src_crs = transform, crs
        self.transform, self.width, self.height = calculate_default_transform(
            crs, WEB_CRS, w, h, *array_bounds(h, w, transform))
        west, south, east, north = transform_bounds(
            WEB_CRS, "EPSG:4326", *array_bounds(self.height, self.width, self.transform))
        self.leaflet_bounds = [[round(south, 6), round(west, 6)], [round(north, 6), round(east, 6)]]

    def warp(self, a):
        out = np.full((self.height, self.width), np.nan, np.float32)
        reproject(a, out, src_transform=self.src_transform, src_crs=self.src_crs, src_nodata=np.nan,
                  dst_transform=self.transform, dst_crs=WEB_CRS, dst_nodata=np.nan, resampling=Resampling.bilinear)
        return out


# ------------------------------------------------------------------ evidence
def gauge_series(csv_path, station_id):
    rows = []
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            if r["station_id"] == station_id and r["gauge_height_hourly_mean_m"] not in ("", None):
                rows.append([r["hour_start_utc"], round(float(r["gauge_height_hourly_mean_m"]), 3)])
    return rows


def copy_layers(cfg, data_root, scene_dir):
    """Map layers (GeoJSON in WGS84): official records, optical reference groups, fields, analysis cells.

    Each layer keeps its own identity ("kind") so the page never draws a reference as a radar detection.
    Returns the layer list for scene.json and the WGS84 bounds of all layers.
    """
    layers, lats, lons = [], [], []

    def walk(c):
        if isinstance(c[0], (int, float)):
            lons.append(c[0])
            lats.append(c[1])
        else:
            for x in c:
                walk(x)

    for lay in cfg.get("layers", []):
        lay = dict(lay)
        src = Path(data_root) / lay.pop("source")
        if lay.get("type") == "image":   # optical context picture, already in Web Mercator, with its own bounds
            shutil.copyfile(src, scene_dir / lay["file"])
            layers.append(lay)
            continue
        gj = json.loads(src.read_text(encoding="utf-8-sig"))
        for f in gj["features"]:
            walk(f["geometry"]["coordinates"])
        shutil.copyfile(src, scene_dir / lay["file"])
        layers.append(lay)
    bounds = [[min(lats), min(lons)], [max(lats), max(lons)]] if lats else None
    return layers, bounds


PASSTHROUGH = ["id", "title", "short_title", "kind", "theme", "place", "mechanism", "what_happened", "sources",
               "use_for", "not_for", "limits", "pins", "track", "frame", "direction", "local_time",
               "product", "audit_note", "story", "interval_short", "interval_labels", "date_notes",
               "default_pair", "class_table", "class_table_note", "radar_summary", "tour", "series_note",
               "task", "optical_text", "agreement", "tables", "downloads", "facts", "colour_options", "candidates",
               "default_view", "default_relative", "headline", "map_note", "fit_contain", "default_opacity", "zoom_out"]


def write_index(cfg, out_root, bounds):
    index_path = Path(out_root) / "index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else []
    entry = {"id": cfg["id"], "title": cfg["title"], "short_title": cfg.get("short_title", cfg["title"]),
             "kind": cfg.get("kind", ""), "theme": cfg.get("theme", ""), "order": cfg.get("order", 99), "bounds": bounds}
    index = sorted([e for e in index if e["id"] != cfg["id"]] + [entry], key=lambda e: (e["order"], e["id"]))
    index_path.write_text(json.dumps(index, indent=1), encoding="utf-8")


def build_objects_only(cfg, data_root, out_root, scene_dir):
    """A case delivered as map objects (cells, fields, official boundaries) with values already computed."""
    layers, bounds = copy_layers(cfg, data_root, scene_dir)
    for d in cfg.get("downloads", []):
        if d.get("source"):
            shutil.copyfile(Path(data_root) / d.pop("source"), scene_dir / d["file"])
    scene = {k: cfg[k] for k in PASSTHROUGH if k in cfg}
    scene.update({"objects_only": True, "bounds": bounds, "layers": layers, "checks": cfg.get("checks", {}),
                  "evidence": cfg.get("evidence", []),
                  "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")})
    (scene_dir / "scene.json").write_text(json.dumps(scene, indent=1), encoding="utf-8")
    write_index(cfg, out_root, bounds)
    print(f"{cfg['id']}: map objects only, {len(layers)} layers")


# ------------------------------------------------------------------ main
def build(config_path, data_root, out_root):
    cfg = json.loads(Path(config_path).read_text(encoding="utf-8-sig"))   # tolerate a BOM from Windows editors
    scene_dir = Path(out_root) / cfg["id"]
    scene_dir.mkdir(parents=True, exist_ok=True)
    if "dates" not in cfg:
        return build_objects_only(cfg, data_root, out_root, scene_dir)
    stack = cfg.get("stack")   # {"hh": ..., "hv": ...}: inputs already in dB, one band per date
    dates = {d["role"]: d for d in cfg["dates"]}
    missing = [r for r in ROLES if r not in dates]
    if missing:
        raise SystemExit(f"Config needs dates with roles {ROLES}; missing {missing}")
    looks, mode = int(cfg.get("looks", 5)), cfg.get("mode", "sliding")

    # --- the three key dates: images, change maps, statistics
    db, valid, transform, crs = read_db([dates[r] for r in ROLES], data_root, cfg["bbox"], looks, mode, stack)
    grid = WebGrid(valid.shape, transform, crs)
    zones = []
    for z in cfg.get("zones", []):
        slices, corners = zone_slices(z, transform, crs, valid.shape)
        zones.append({"name": z["name"], "kind": z.get("kind", "target"), "bounds": corners, "slices": slices})

    images = {"backscatter": {}, "change": {}}
    stats = {}
    relative_offsets, relative_checks = {}, {}
    if cfg.get("relative_view") == "window_median":
        images["change_rel"] = {}
    for j, p in enumerate(POLS):
        images["backscatter"][p] = {}
        for i, r in enumerate(ROLES):
            name = f"{p}_{r}.png"
            save_png(scene_dir / name, grid.warp(db[i][j]), *STRETCH_DB[p], grey_palette())
            images["backscatter"][p][r] = name
        normal, event = db[1][j] - db[0][j], db[2][j] - db[1][j]
        images["change"][p] = {}
        if "change_rel" in images:
            images["change_rel"][p] = {}
            relative_offsets[p], relative_checks[p] = {}, {}
        for label, change in (("normal", normal), ("event", event)):
            name = f"change_{label}_{p}.png"
            save_png(scene_dir / name, grid.warp(change), -CHANGE_LIMIT_DB, CHANGE_LIMIT_DB, change_palette())
            images["change"][p][label] = name
            if "change_rel" in images:
                good = valid & np.isfinite(change)
                if not np.any(good):
                    raise ValueError("No valid pixels for relative view")
                offset = float(np.median(change[good]))
                rel = np.where(good, change - offset, np.nan)
                rel_name = f"change_{label}_{p}_rel.png"
                save_png(scene_dir / rel_name, grid.warp(rel), -CHANGE_LIMIT_DB, CHANGE_LIMIT_DB, change_palette())
                images["change_rel"][p][label] = rel_name
                relative_offsets[p][label] = offset
                residual = float(np.median(rel[good]))
                assert abs(residual) <= 0.05, (p, label, residual)
                relative_checks[p][label] = {"valid_pixels": int(good.sum()), "relative_median_db": residual}
        stats[p] = {"normal": summary(normal), "event": summary(event)}
        for z in zones:
            z.setdefault("stats", {})[p] = {"normal": summary(normal[z["slices"]]), "event": summary(event[z["slices"]])}

    # --- the time series: either the three key dates, or a longer list from the config
    event_date = dates["after"]["date"]
    if cfg.get("series"):
        series_dates = sorted(cfg["series"], key=lambda d: d["date"])
        sdb, svalid, _, _ = read_db(series_dates, data_root, cfg["bbox"], looks, mode, stack)
        (scene_dir / "series").mkdir(exist_ok=True)
        series_images = []
        for i, d in enumerate(series_dates):
            names = {}
            for j, p in enumerate(POLS):
                names[p] = f"series/{p}_{d['date'].replace('-', '')}.png"
                save_png(scene_dir / names[p], grid.warp(sdb[i][j]), *STRETCH_DB[p], grey_palette())
            series_images.append(names)
        series_valid = float(svalid.mean())
    else:
        series_dates = [dates[r] for r in ROLES]
        sdb, series_valid = db, float(valid.mean())
        series_images = [{p: images["backscatter"][p][r] for p in POLS} for r in ROLES]
    areas = [{"name": "Whole area shown", "kind": "all", "slices": (slice(None), slice(None))}] + zones
    story = cfg.get("story", "baseline_event")   # "three_dates" = two real changes, no quiet baseline

    def phase(d):
        if story != "baseline_event":
            return "date"
        return "after" if d["date"] >= event_date else "before"

    series = {
        "valid_fraction": round(series_valid, 4),
        "dates": [{"date": d["date"], "time_utc": d.get("time_utc", ""), "crid": d.get("crid", ""),
                   "phase": phase(d), "images": series_images[i]}
                  for i, d in enumerate(series_dates)],
        "areas": [{"name": a["name"], "kind": a["kind"],
                   **{f"{p}_db": [median_db(sdb[i][j][a["slices"]]) for i in range(len(series_dates))]
                      for j, p in enumerate(POLS)}} for a in areas],
    }

    # --- checks
    crids = sorted({d["crid"] for d in cfg["dates"]} | {d.get("crid", "") for d in series_dates} - {""})
    posting_m = abs(transform.a)
    footprint_m = cfg.get("footprint_m") or (posting_m if mode == "block" or stack else posting_m * looks)
    checks = {"same_processing_version": {
        "question": "Same processing version on all dates?",
        "value": len(crids) == 1,
        "text": f"All dates use {crids[0]}." if len(crids) == 1
        else "Mixed processing versions: " + ", ".join(f"{dates[r]['date']} {dates[r]['crid']}" for r in ROLES) + "."}}
    if story == "baseline_event":
        quiet = abs(stats["hh"]["normal"]["median_db"]) < 0.5
        checks["baseline_quiet"] = {
            "question": "Was the normal period quiet?",
            "value": bool(quiet),
            "text": f"Median HH change between the two baseline dates is {stats['hh']['normal']['median_db']:+.2f} dB."}
    default_questions = {"independent_evidence": "Is there independent evidence of the event?",
                         "reference_extent": "Is there an official extent to test against?"}
    for key, check in cfg.get("checks", {}).items():
        checks[key] = {"question": default_questions.get(key, key), **check}

    evidence = []
    for item in cfg.get("evidence", []):
        item = dict(item)
        if item.get("type") == "gauge":
            item["series"] = gauge_series(Path(data_root) / item.pop("csv"), item["station_id"])
        if item.get("type") == "image":
            shutil.copyfile(Path(data_root) / item.pop("source"), scene_dir / item["file"])
        evidence.append(item)

    layers, _ = copy_layers(cfg, data_root, scene_dir)
    object_series = json.loads((Path(data_root) / cfg["object_series"]).read_text(encoding="utf-8")) if cfg.get("object_series") else None
    for d in cfg.get("downloads", []):
        if d.get("source"):
            shutil.copyfile(Path(data_root) / d.pop("source"), scene_dir / d["file"])
    scene = {k: cfg[k] for k in PASSTHROUGH if k in cfg}
    scene.update({
        "layers": layers,
        "object_series": object_series,
        "dates": {r: {k: dates[r][k] for k in ("date", "time_utc", "crid", "granule") if k in dates[r]} for r in ROLES},
        "bounds": grid.leaflet_bounds,
        "images": images,
        "stats": stats,
        "series": series,
        "zones": [{k: z[k] for k in ("name", "kind", "bounds", "stats")} for z in zones],
        "checks": checks,
        "evidence": evidence,
        "display": {"stretch_db": STRETCH_DB, "change_limit_db": CHANGE_LIMIT_DB,
                    "posting_m": posting_m, "footprint_m": footprint_m, "mode": mode,
                    "valid_fraction": round(float(valid.mean()), 4)},
        "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    })
    if "change_rel" in images:
        scene["display"]["relative"] = {
            "label": "Relative to the whole window", "offsets": relative_offsets,
            "note": "Each change minus the median change of the whole window. This takes out the typical change of the whole area, which may include widespread wetting and part of any processing-version offset. What remains is where a place changed more or less than its surroundings. This is display centering, not proof that spatial processing-version differences or environmental effects have been corrected.",
            "validation": relative_checks}
    (scene_dir / "scene.json").write_text(json.dumps(scene, indent=1), encoding="utf-8")

    write_index(cfg, out_root, grid.leaflet_bounds)
    print(f"{cfg['id']}: {valid.shape[1]} x {valid.shape[0]} px at {posting_m:g} m, valid {valid.mean():.1%}, "
          f"{len(series_dates)} dates in series, {len(zones)} zones")
    for p in POLS:
        print(f"  {p.upper()} normal {stats[p]['normal']['median_db']:+.2f} dB, event {stats[p]['event']['median_db']:+.2f} dB")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Build a scene package for the NISAR Change Explorer.")
    ap.add_argument("config", nargs="+", help="one or more scene config JSON files")
    ap.add_argument("--data-root", required=True, help="folder that the config's raster and evidence paths are relative to")
    ap.add_argument("--out", required=True, help="scenes folder of the web page")
    args = ap.parse_args()
    for c in args.config:
        build(c, args.data_root, args.out)
