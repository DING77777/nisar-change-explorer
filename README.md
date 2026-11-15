# NISAR Change Explorer

Team Space NUTS (Perth, Western Australia). NASA Space Apps Challenge 2026, challenge "Dancing with the SARs".

NISAR Change Explorer turns NASA-ISRO NISAR L-band radar changes into map cells you can see, check against other evidence and export as GIS files.

- Live app: https://ding77777.github.io/nisar-change-explorer/
- 7-slide demo: https://ding77777.github.io/nisar-change-explorer/slides.html

## What it does

1. **Shows the result first.** The lead case, Sale Common wetland in Victoria, opens with the cells that pass a stated rule, drawn on a dated optical image.
2. **Lets you check it.** Swipe between radar dates or change periods, click a point, field or cell for its values and history, and read a six-step evidence panel: why this place, what optical images and records show, what the radar shows, whether they agree, polarisation and quality, and what you can take away.
3. **Lets you set the rule and take the result away.** Choose HH or HV, period, direction and threshold; see how many cells pass and how many fall in each independent reference group; download the passing cells as GeoJSON with the rule written into every feature.

## Cases

| Theme | Case | Independent evidence |
|---|---|---|
| Water | Sale Common wetland, Victoria (lead case) | Sentinel-2 water labels made without the radar |
| Water | Laidley, Warrill Creek, Caboolture and a regional view, Queensland | River gauges and rainfall |
| Farmland | Burdekin fields, Queensland | Sentinel-2 greenness (NDVI) for the same fields |
| Fire | Rockadooie prescribed burn, New South Wales | Official final burn boundary; Sentinel-2 burn index |
| Mountain hazard | Timure, Nepal, after the 26 August 2026 landslide | Copernicus EMS mapped impact |

Sixteen more places tested with the same workflow are listed in the app's case library.

## How a case is made

1. NISAR L2 GCOV backscatter (HH and HV, Frequency A) from one track and frame is cropped to a small window.
2. Only pixels valid on every date in both polarisations are kept, using the product's own quality layers.
3. Linear power is averaged over a small window and converted to decibels once. Inputs already in decibels are never converted again.
4. Change is the later date minus the earlier date. Each event change is shown next to a reference: a quiet period before the event, stable land, or the surroundings.
5. Results are compared with independent evidence and packaged for the web page.

## Repository layout

| Folder | Contents |
|---|---|
| `docs/` | The web app and the slides (static files). `docs/scenes/<case>/` holds each case: display images, `scene.json` and GeoJSON layers. |
| `recipe/` | `make_scene.py` builds a case package from a config; `scene_configs/` has one config per case; `prepare_object_inputs.py` converts finished cell and field tables into web inputs; `make_slide_figures.py` draws the slide figures. |

## Run it locally

```
cd docs
python -m http.server 8765
```

Open http://localhost:8765. The page loads Leaflet from cdnjs and OpenStreetMap tiles; no keys or accounts are needed.

To rebuild a case, download the NISAR granules listed in its config from the Alaska Satellite Facility (free NASA Earthdata login), then run:

```
python recipe/make_scene.py recipe/scene_configs/vic_sale_common.json --data-root <data-root> --out docs/scenes
```

Requires Python 3.12 with rasterio, numpy and pillow.

## Data and credits

- NISAR L2 GCOV: NASA and ISRO, distributed by the Alaska Satellite Facility DAAC. https://search.asf.alaska.edu/ and https://nisar-docs.asf.alaska.edu/
- Optical images, water labels, greenness and burn index: Geoscience Australia, Digital Earth Australia Sentinel-2 surface reflectance (Sentinel-2B DOI 10.26186/146551, Sentinel-2C DOI 10.26186/150143), CC BY 4.0. Contains modified Copernicus Sentinel data 2026. Cropped, cloud-masked, colour-stretched and reprojected by Space NUTS.
- Timure mapped impact: Copernicus Emergency Management Service (© European Union), EMSR927, via UNESCO IHP-WINS. Seismic event time: USGS.
- Rockadooie burn record and final boundary: NSW National Parks and Wildlife Service fire history.
- River levels: Queensland Government Water Monitoring Information Portal, CC BY 4.0. Rainfall: SILO, Queensland Government, CC BY 4.0.
- Sale Common closure notice: Parks Victoria. Burdekin season context: Wilmar Sugar. Land use 2016 (background only): State of Queensland.
- Darwin tide records (case library): Bureau of Meteorology.
- Base map: © OpenStreetMap contributors, ODbL. Map library: Leaflet (BSD 2-Clause).

## Why we included Timure

On 26 August 2026 an ice-rock avalanche high in the Himalaya sent a debris flow down the valley at Timure, Nepal. We followed the stories of the people affected, and they stayed with us. Events like this are very hard to foresee: stress builds up in unstable, ice-covered slopes until they suddenly fail. We wanted to see what NISAR recorded, from the first available pass in June to October. The radar clearly shows the change across the event inside the area mapped by Copernicus; the data we could obtain do not show movement before it. Whether a long radar record can reveal slow changes before such failures is a question we would like to help answer, so that fewer of these tragedies happen.

## Scope

Cells are candidates for field checking, compared with optical labels and official records rather than ground surveys. NISAR revisits every 12 days, so the app records change between passes; it is not a warning system. One Queensland date uses a newer NISAR processing version, which the page flags.

## Use of AI

The team discussed and agreed on the project goals together. Qing Ding led the project work, while Will Shu organised the data and provided technical support. The team made the final project decisions together.

AI tools (Claude, Codex) assisted with writing and debugging data-processing and web code, and reviewing text. Satellite observations come from the data providers cited in the project and were not generated by AI. The team logo was generated using an AI image tool and is labelled accordingly. AI assistance is acknowledged in the repository README and source-code headers.

## Licence

Code: Apache License 2.0 (see `LICENSE`). Data, images and maps keep the licences of their sources listed above.
