# AI-assisted code (Claude, Codex); see README, Use of AI.
"""
Turn the team's finished case packages into small, public web inputs (GeoJSON + JSON).

Only fields needed for display are copied. No local paths, no private manifests.
Values are copied as delivered; nothing is recomputed here.

Usage:
  uv run --no-project python prepare_object_inputs.py --data-root <data-root> --out <data-root>/web_inputs_20261115
"""

import argparse
import csv
import json
from pathlib import Path


def load(p):
    return json.loads(Path(p).read_text(encoding="utf-8-sig"))


def rnd(coords, nd=6):
    if isinstance(coords, (int, float)):
        return round(coords, nd)
    return [rnd(c, nd) for c in coords]


def feature(geom, props):
    return {"type": "Feature", "properties": props, "geometry": {"type": geom["type"], "coordinates": rnd(geom["coordinates"])}}


def save(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print("wrote", path)


def r(v, nd=3):
    return None if v is None else round(float(v), nd)


# ------------------------------------------------------------------ Burdekin
def burdekin(root, out):
    src = root / "evidence/validation_candidates_20261115/agriculture_optical_run1/burdekin_transition_optical/package_v2/scene_evidence_public_v2.json"
    j = load(src)
    label = {"greenness_decrease": "greenness fell", "greenness_increase": "greenness rose",
             "approximately_stable": "about stable (Jun to Aug)", "intermediate": "mixed"}
    feats, objects = [], {}
    for f in j["roi_geojson"]["features"]:
        p = f["properties"]
        lu = p.get("landuse_history") or [{}]
        feats.append(feature(f["geometry"], {
            "id": p["id"], "optical_label": label.get(p["optical_label"], p["optical_label"]),
            "accepted": bool(p["accepted_for_SAR_comparison"]), "cells_100m": p["full_valid_100m_cells"],
            "landuse_2016": lu[0].get("tertiary"), "meaning": "Hand-drawn rectangle inside a field seen in optical images; not a property boundary"}))
        objects[p["id"]] = {"accepted": bool(p["accepted_for_SAR_comparison"]), "radar": {"dates": [], "hh": [], "hv": []},
                            "optical": {"dates": [], "ndvi": [], "p10": [], "p90": [], "pass": []}}
    for o in sorted(j["radar_observations"], key=lambda x: x["acquired_utc"]):
        rad = objects[o["roi_id"]]["radar"]
        t = o["acquired_utc"]
        if t not in rad["dates"]:
            rad["dates"].append(t)
            rad["hh"].append(None)
            rad["hv"].append(None)
        rad[o["polarization"].lower()][rad["dates"].index(t)] = r(o["median_db"], 2)
    for o in sorted(j["optical_observations"], key=lambda x: x["acquired_utc"]):
        opt = objects[o["roi_id"]]["optical"]
        opt["dates"].append(o["acquired_utc"])
        opt["ndvi"].append(r(o["NDVI"]["median"]) if o["coverage_pass"] else None)
        opt["p10"].append(r(o["NDVI"]["p10"]) if o["coverage_pass"] else None)
        opt["p90"].append(r(o["NDVI"]["p90"]) if o["coverage_pass"] else None)
        opt["pass"].append(bool(o["coverage_pass"]))
    for e in j["endpoint_comparisons"]:
        ob = objects[e["roi_id"]]
        ob.setdefault("endpoint", {"sar_from": e["earlier_SAR_utc"], "sar_to": e["later_SAR_utc"],
                                   "optical_from": e["NDVI_change_same_support"]["earlier_optical_utc"],
                                   "optical_to": e["NDVI_change_same_support"]["later_optical_utc"],
                                   "cells_100m": e["valid_100m_cells"],
                                   "ndvi_change": r(e["NDVI_change_same_support"]["median_of_pixelwise_differences"])})
        ob["endpoint"][e["polarization"].lower() + "_change_db"] = r(e["SAR_delta_db"]["median_of_cellwise_differences"])
    for k in objects:
        if not objects[k]["accepted"]:
            objects[k]["radar"] = None   # F: excluded before any radar comparison; no radar rows exist
    save(out / "burdekin/fields.geojson", {"type": "FeatureCollection", "features": feats})
    save(out / "burdekin/fields_series.json", objects)
    rejected = [x["acquired_utc"][:10] for x in j["rejected_optical_entries"]]
    print("  optical dates failing QA for every field:", rejected)
    rows = [[k, objects[k]["endpoint"]["cells_100m"], objects[k]["endpoint"]["ndvi_change"],
             objects[k]["endpoint"]["hh_change_db"], objects[k]["endpoint"]["hv_change_db"]]
            for k in sorted(objects) if "endpoint" in objects[k]]
    with open(out / "burdekin/fields_endpoint_changes.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["field", "cells_100m", "ndvi_change_21jun_to_20aug", "hh_change_db_20jun_to_19aug", "hv_change_db_20jun_to_19aug"])
        w.writerows(rows)
    for row in rows:
        print("  ", row)


# ------------------------------------------------------------------ Rockadooie
def rockadooie(root, out):
    cells = load(root / "ROCKADOOIE_LOCAL_REVIEW_20261115_1120/all_cells_with_QA.geojson")
    insp = {f["properties"]["id"]: f["properties"] for f in
            load(root / "ROCKADOOIE_OPTICAL_SAMPLE_AUDIT_20261115_1253/gis_inspection_package_1330/disagreement_inspection.geojson")["features"]}
    feats = []
    for f in cells["features"]:
        p = f["properties"]
        q = insp.get(p["id"], {})
        valid = bool(p.get("valid_common"))
        cat = p.get("category") if valid else "no_common_data"
        feats.append(feature(f["geometry"], {
            "id": p["id"], "window": p["window"], "valid": valid, "category": cat,
            "hh_normal_db": r(p.get("HH_baseline_db"), 2), "hh_event_db": r(p.get("HH_event_db"), 2),
            "hv_normal_db": r(p.get("HV_baseline_db"), 2), "hv_event_db": r(p.get("HV_event_db"), 2),
            "dnbr": r(p.get("dNBR")), "inside_official_fraction": r(p.get("official_boundary_fraction_20m_centres"), 2),
            "in_default_disagreement": p["id"] in insp,
            "disagree_in_9_rules": q.get("disagreement_nine_count"),
            "optical_spot_check": q.get("optical_recompute_sampled", False)}))
    save(out / "rockadooie/cells.geojson", {"type": "FeatureCollection", "features": feats})
    win = load(root / "ROCKADOOIE_LOCAL_REVIEW_20261115_1120/available_windows.geojson")
    save(out / "rockadooie/windows.geojson", {"type": "FeatureCollection", "features": [
        feature(f["geometry"], {"window": f["properties"]["window"], "valid_common_ha": f["properties"]["valid_common_ha"]}) for f in win["features"]]})
    off = load(root / "evidence/ALT_FIRE_20261115/Rockadooie_HR/official_boundary.geojson")
    save(out / "rockadooie/official_final_boundary.geojson", {"type": "FeatureCollection", "features": [
        feature(f["geometry"], {"name": "Official final fire boundary (NSW NPWS fire history)", "area_ha": 3006.99}) for f in off["features"]]})
    from collections import Counter
    print("  categories:", Counter((x["properties"]["window"], x["properties"]["category"]) for x in feats))
    print("  stable in all 9 rules:", sum(1 for x in feats if x["properties"]["disagree_in_9_rules"] == 9))


# ------------------------------------------------------------------ Gyirong / Timure
def gyirong(root, out):
    base = root / "GYIRONG_MINIMAL_DEMO_HANDOFF_20261115"
    cells = load(base / "ems_overlap_all395_cells.geojson")
    feats = []
    for f in cells["features"]:
        p = f["properties"]
        valid = bool(p.get("common_valid"))
        feats.append(feature(f["geometry"], {
            "id": p["cell_id"], "valid": valid,
            "hh_cross_db": r(p.get("HH_cross_db"), 2) if valid else None, "hv_cross_db": r(p.get("HV_cross_db"), 2) if valid else None,
            "hh_post_db": r(p.get("HH_post_db"), 2) if valid else None, "hv_post_db": r(p.get("HV_post_db"), 2) if valid else None}))
    save(out / "gyirong/ems_cells.geojson", {"type": "FeatureCollection", "features": feats})
    ev = load(base / "independent_ems_event_original.geojson")
    save(out / "gyirong/ems_observed_event.geojson", {"type": "FeatureCollection", "features": [
        feature(f["geometry"], {"name": "Copernicus EMS observed event (landslide, photo-interpreted, 27 Aug imagery)"}) for f in ev["features"]]})
    aoi = load(base / "independent_ems_mapping_aoi_original.geojson")
    save(out / "gyirong/ems_mapping_aoi.geojson", {"type": "FeatureCollection", "features": [
        feature(f["geometry"], {"name": "Copernicus EMS mapping area"}) for f in aoi["features"]]})
    loc = load(base / "locators_not_flow_path.geojson")
    save(out / "gyirong/locators.geojson", {"type": "FeatureCollection", "features": [
        feature(f["geometry"], {"name": f["properties"]["label"]}) for f in loc["features"]]})
    v = [x["properties"] for x in feats if x["properties"]["valid"]]
    print(f"  cells {len(feats)}, valid {len(v)}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-root", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    root, out = Path(a.data_root), Path(a.out)
    burdekin(root, out)
    rockadooie(root, out)
    gyirong(root, out)
