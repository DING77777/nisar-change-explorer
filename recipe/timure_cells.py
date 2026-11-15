# AI-assisted code (Claude, Codex); see README, Use of AI.
"""50 m radar cells inside the Copernicus EMS mapped impact at Timure, from the wide 10 m window.

Each cell is a 5 x 5 block of native 10 m pixels. Linear power is averaged only when all 25 pixels are
valid on all three dates in both polarisations, then converted to dB once. A cell belongs to the
impact when its centre lies inside the EMS outline. Cells without full support keep null values.

Usage: python timure_cells.py <wide data folder> <ems_observed_event.geojson> <out.geojson> [ems_mapping_aoi.geojson]
With the mapping area given, cells cover the whole area mapped by EMS and carry in_impact.
"""

import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import transform_geom
from shapely.geometry import Point, shape, mapping, box
from shapely.ops import transform as shp_transform
from pyproj import Transformer

DATES = ["20260819", "20260831", "20260912"]   # before, first pass after, later
N = 5


def main(folder, ems_path, out_path, aoi_path=None):
    folder = Path(folder)
    arrays, valid = {}, None
    for d in DATES:
        for pol in ("HHHH", "HVHV"):
            with rasterio.open(folder / f"{d}_{pol}.tif") as src:
                a = src.read(1).astype(np.float64)
                crs, tr = src.crs, src.transform
            arrays[(d, pol)] = a
            good = np.isfinite(a) & (a > 0)
            valid = good if valid is None else valid & good
        with rasterio.open(folder / f"{d}_valid.tif") as src:
            valid &= src.read(1) == 1
    rows, cols = valid.shape[0] // N, valid.shape[1] // N
    blk = lambda a: a[: rows * N, : cols * N].reshape(rows, N, cols, N)
    full = blk(valid).all(axis=(1, 3))
    db = {}
    for k, a in arrays.items():
        m = blk(np.where(valid, a, 0.0)).mean(axis=(1, 3))
        db[k] = np.where(full, 10 * np.log10(np.where(full, m, 1.0)), np.nan)

    ems = shape(json.load(open(ems_path, encoding="utf-8-sig"))["features"][0]["geometry"])
    ems_native = shape(transform_geom("EPSG:4326", crs, mapping(ems)))
    area = ems_native
    if aoi_path:
        aoi = shape(json.load(open(aoi_path, encoding="utf-8-sig"))["features"][0]["geometry"])
        area = shape(transform_geom("EPSG:4326", crs, mapping(aoi)))
    to_wgs = Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform
    feats = []
    for r in range(rows):
        for c in range(cols):
            x0, y0 = tr * (c * N, r * N)
            x1, y1 = tr * ((c + 1) * N, (r + 1) * N)
            cell = box(min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))
            if not area.contains(cell.centroid):
                continue
            inside = bool(ems_native.contains(cell.centroid))
            ok = bool(full[r, c])
            val = lambda d1, d0, pol: round(float(db[(d1, pol)][r, c] - db[(d0, pol)][r, c]), 2) if ok else None
            geom = shp_transform(to_wgs, cell)
            feats.append({"type": "Feature", "properties": {
                "id": f"r{r:03d}c{c:03d}", "valid": ok, "in_impact": inside,
                "hh_cross_db": val(DATES[1], DATES[0], "HHHH"), "hv_cross_db": val(DATES[1], DATES[0], "HVHV"),
                "hh_post_db": val(DATES[2], DATES[1], "HHHH"), "hv_post_db": val(DATES[2], DATES[1], "HVHV")},
                "geometry": json.loads(json.dumps(mapping(geom), default=float))})
    for f in feats:
        f["geometry"]["coordinates"] = [[[round(x, 6), round(y, 6)] for x, y in ring] for ring in f["geometry"]["coordinates"]]
    Path(out_path).write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")), encoding="utf-8")

    v = [f["properties"] for f in feats if f["properties"]["valid"] and f["properties"]["in_impact"]]
    print("all cells", len(feats), "in impact", sum(f["properties"]["in_impact"] for f in feats))
    n = len(v)
    print(f"cells {len(feats)}, valid {n}")
    for k in ("hv_cross_db", "hv_post_db", "hh_cross_db", "hh_post_db"):
        a = np.array([p[k] for p in v])
        print(f"{k}: |x|>3 {100 * np.mean(np.abs(a) > 3):.2f}%  <-3 {100 * np.mean(a < -3):.2f}%  |x|<=1 {100 * np.mean(np.abs(a) <= 1):.2f}%")


if __name__ == "__main__":
    main(*sys.argv[1:5])
